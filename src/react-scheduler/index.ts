import { resetContextDependences } from '../react-context/fiber-context'
import {
  computeAsyncExpiration, computeInteractiveExpiration, ExpirationTime, expirationTimeToMS, msToExpirationTime, Never, NoWork, Sync,
} from '../react-fiber/expiration-time'
import { createWorkInProgress, Fiber } from '../react-fiber/fiber'
import { Batch, FiberRoot } from '../react-fiber/fiber-root'
import {
  Callback,
  ContentReset,
  Deletion,
  DidCapture,
  HostEffectMask,
  Incomplete,
  NoEffect,
  Passive,
  PerformedWork,
  Placement,
  PlacementAndUpdate,
  Ref,
  SideEffectTag,
  Snapshot,
  Update,
} from '../react-type/effect-type'
import { HostRoot } from '../react-type/tag-type'
import { ConcurrentMode } from '../react-type/work-type'
import { beginWork } from '../react-work/begin-work'
import { commitAttachRef, commitBeforeMutationLifecycle, commitDeletion, commitDetachRef, commitLifeCycles, commitPlacement, commitResetTextContent, commitWork } from '../react-work/commit-work'
import { completeWork } from '../react-work/complete-work'
import { throwException, unwindInterruptedWork, unwindWork } from '../react-work/unwind-work'
import { clearTimeout, noTimeout, now } from '../utils/browser'
import { markCommittedPriorityLevels, markPendingPriorityLevel } from './pending-priority'
import { cancelDeferredCallback, scheduleDeferredCallback } from './scheduler'

const NESTED_UPDATE_LIMIT: number = 50
let nestedUpdateCount: number = 0
let lastCommittedRootDuringThisBatch: FiberRoot = null

let callbackExpirationTime: ExpirationTime = NoWork
let callbackID: any

let isRendering: boolean = false
let isWorking: boolean = false
let isCommitting: boolean = false

const originalStartTimeMs: number = now()

let currentRendererTime: ExpirationTime = msToExpirationTime(originalStartTimeMs)
let currentSchedulerTime: ExpirationTime = currentRendererTime

const expirationContext: ExpirationTime = NoWork

const isBatchingUpdates: boolean = false
let isUnbatchingUpdates: boolean = false
const isBatchingInteractiveUpdates: boolean = false

let completedBatches: Batch[] = null

function recomputeCurrentRendererTime() {
  const currentTimeMs: number = now() - originalStartTimeMs
  currentRendererTime = msToExpirationTime(currentTimeMs)
}

let firstScheduledRoot: FiberRoot = null
let lastScheduledRoot: FiberRoot = null

let nextFlushedRoot: FiberRoot = null
let nextFlushedExpirationTime: ExpirationTime = NoWork
let lowestPriorityPendingInteractiveExpirationTime: ExpirationTime = NoWork

let hasUnhandledError: boolean = false
let unhandledError: any = null

let nextRoot: FiberRoot = null
let nextUnitOfWork: Fiber = null
let nextRenderExpirationTime: ExpirationTime = NoWork
let nextLatestAbsoluteTimeoutMs: number = -1
let nextRenderDidError: boolean = false

let nextEffect: Fiber = null

let rootWithPendingPassiveEffects: FiberRoot = null
let legacyErrorBoundariesThatAlreadyFailed: Set<any> = null

let interruptedBy: Fiber = null

function resetStack() {
  if (nextUnitOfWork !== null) {
    let interruptedWork: Fiber = nextUnitOfWork.return
    while (interruptedWork !== null) {
      unwindInterruptedWork(interruptedWork)
      interruptedWork = interruptedWork.return
    }
  }

  nextRoot = null
  nextUnitOfWork = null
  nextRenderExpirationTime = NoWork
  nextLatestAbsoluteTimeoutMs = -1
  nextRenderDidError = false
}

function unbatchedUpdates(fn: Function, a?: any): Function {
  if (isBatchingUpdates && !isUnbatchingUpdates) {
    isUnbatchingUpdates = true
    try {
      return fn(a)
    } finally {
      isUnbatchingUpdates = false
    }
  }
  return fn(a)
}

function onUncaughtError(error: any) {
  nextFlushedRoot.expirationTime = NoWork
  if (!hasUnhandledError) {
    hasUnhandledError = true
    unhandledError = error
  }
}

function computeExpirationTimeForFiber(currentTime: ExpirationTime, fiber: Fiber): ExpirationTime {
  let expirationTime: ExpirationTime = NoWork

  if (expirationContext !== NoWork) {
    expirationTime = expirationContext
  } else if (isWorking) {
    expirationTime = isCommitting ? Sync : nextRenderExpirationTime
  } else {
    if (fiber.mode === ConcurrentMode) {
      if (isBatchingInteractiveUpdates) {
        expirationTime = computeInteractiveExpiration(currentTime)
      } else {
        expirationTime = computeAsyncExpiration(currentTime)
      }

      if (nextRoot !== null && expirationTime === nextRenderExpirationTime) {
        expirationTime -= 1
      }
    } else {
      expirationTime = Sync
    }
  }

  if (isBatchingInteractiveUpdates) {
    if (lowestPriorityPendingInteractiveExpirationTime === NoWork
      || expirationTime < lowestPriorityPendingInteractiveExpirationTime) {
      lowestPriorityPendingInteractiveExpirationTime = expirationTime
    }
  }

  return expirationTime
}

function resetChildExpirationTime(workInProgress: Fiber, renderTime: ExpirationTime) {
  if (renderTime !== Never && workInProgress.childExpirationTime === Never) { // 子节点hidden的，直接跳过
    return
  }
  let newChildExpiration: ExpirationTime = NoWork
  let child: Fiber = workInProgress.child

  while (child !== null) {
    const childUpdateExpirationTime = workInProgress.expirationTime
    const childChildExpirationTime = workInProgress.childExpirationTime

    if (childUpdateExpirationTime > newChildExpiration) {
      newChildExpiration = childUpdateExpirationTime
    }

    if (childChildExpirationTime > newChildExpiration) {
      newChildExpiration = childChildExpirationTime
    }
    child = child.sibling
  }
  workInProgress.childExpirationTime = newChildExpiration
}

function findHighestPriorityRoot() {
  let highestPriorityWork: ExpirationTime = NoWork
  let highestPriorityRoot: FiberRoot = null

  if (lastScheduledRoot !== null) {
    let previousScheduledRoot: FiberRoot = lastScheduledRoot
    let root: FiberRoot = firstScheduledRoot

    // 遍历出一条需要scheduled的fiber-root链表
    while (root !== null) {
      const remainingExpirationTime: ExpirationTime = root.expirationTime

      if (remainingExpirationTime === NoWork) {
        if (root === root.nextScheduledRoot) { // 整个链表只有一个fiber root
          root.nextScheduledRoot = null
          firstScheduledRoot = lastScheduledRoot = null
          break

        } else if (root === firstScheduledRoot) {
          const next = root.nextScheduledRoot
          firstScheduledRoot = next
          lastScheduledRoot.nextScheduledRoot = next
          root.nextScheduledRoot = null

        } else if (root === lastScheduledRoot) {
          lastScheduledRoot = previousScheduledRoot
          lastScheduledRoot.nextScheduledRoot = firstScheduledRoot
          root.nextScheduledRoot = null
          break

        } else {
          previousScheduledRoot.nextScheduledRoot = root.nextScheduledRoot
          root.nextScheduledRoot = null
        }

        root = previousScheduledRoot.nextScheduledRoot
      } else {
        if (remainingExpirationTime > highestPriorityWork) {
          highestPriorityWork = remainingExpirationTime
          highestPriorityRoot = root
        }

        if (root === lastScheduledRoot) {
          break
        }

        if (highestPriorityWork === Sync) {
          break // sync是最高级，直接退出
        }

        previousScheduledRoot = root
        root = root.nextScheduledRoot
      }
    }
  }
  nextFlushedRoot = highestPriorityRoot
  nextFlushedExpirationTime = highestPriorityWork
}

function requestCurrentTime(): ExpirationTime {
  if (isRendering) {
    return currentSchedulerTime
  }

  findHighestPriorityRoot()

  if (nextFlushedExpirationTime === NoWork || nextFlushedExpirationTime === Never) {
    recomputeCurrentRendererTime()
    currentSchedulerTime = currentRendererTime
    return currentSchedulerTime
  }

  return currentSchedulerTime
}

function scheduleWorkToRoot(fiber: Fiber, expirationTime: ExpirationTime): FiberRoot | null {
  let { alternate }: { alternate: Fiber } = fiber

  if (fiber.expirationTime < expirationTime) {
    fiber.expirationTime = expirationTime
  }

  if (alternate !== null && alternate.expirationTime < expirationTime) {
    alternate.expirationTime = expirationTime
  }

  let node: Fiber = fiber.return
  let root: FiberRoot = null

  if (node === null && node.tag === HostRoot) {
    root = fiber.stateNode
  } else {
    while (node !== null) {
      ({ alternate } = node)

      if (node.childExpirationTime < expirationTime) {
        node.childExpirationTime = expirationTime
      }

      if (alternate !== null && alternate.childExpirationTime < expirationTime) {
        alternate.childExpirationTime = expirationTime
      }

      if (node === null && node.tag === HostRoot) {
        root = fiber.stateNode
        break
      }

      node = node.return
    }
  }
  return root
}


function scheduleWork(fiber: Fiber, expirationTime: ExpirationTime) {
  const root = scheduleWorkToRoot(fiber, expirationTime)

  if (!isWorking && nextRenderExpirationTime !== NoWork && expirationTime > nextRenderExpirationTime) {
    interruptedBy = fiber
    resetStack()
  }

  markPendingPriorityLevel(root, expirationTime)

  if (!isWorking || isCommitting || nextRoot !== root) {
    const rootExpirationTime = root.expirationTime
    requestWork(root, rootExpirationTime)
  }

  if (nestedUpdateCount > NESTED_UPDATE_LIMIT) {
    nestedUpdateCount = 0
  }
}

function requestWork(root: FiberRoot, expirationTime: ExpirationTime) {
  addRootToSchedule(root, expirationTime)
  if (isRendering) {
    return
  }

  if (isBatchingUpdates) {
    if (isUnbatchingUpdates) {
      nextFlushedRoot = root
      nextFlushedExpirationTime = Sync
      performWorkOnRoot(root, Sync, false)
    }
    return
  }

  if (expirationTime === Sync) {
    performSyncWork() // 同步
  } else {
    scheduleCallbackWithExpirationTime(expirationTime) // 异步，待实现
  }
}

function addRootToSchedule(root: FiberRoot, expirationTime: ExpirationTime) {
  if (root.nextScheduledRoot === null) {
    root.expirationTime = expirationTime

    if (lastScheduledRoot === null) {
      firstScheduledRoot = lastScheduledRoot = root
      root.nextScheduledRoot = root
    } else {
      lastScheduledRoot.nextScheduledRoot = root
      lastScheduledRoot = root
      root.nextScheduledRoot = firstScheduledRoot
    }
  } else {
    const remainingExpirationTime = root.expirationTime
    if (expirationTime > remainingExpirationTime) {
      root.expirationTime = expirationTime
    }
  }
}

function performSyncWork() {
  performWork(Sync, false)
}

function scheduleCallbackWithExpirationTime(expirationTime: ExpirationTime) {
  if (callbackExpirationTime !== NoWork) {
    if (expirationTime < callbackExpirationTime) {
      return
    } else if (callbackID !== null) {
      cancelDeferredCallback(callbackID)
    }
  }

  callbackExpirationTime = expirationTime
  const currentMs = now() - originalStartTimeMs
  const expirationTimeMs = expirationTimeToMS(expirationTime)
  const timeout = expirationTimeMs - currentMs
  callbackID = scheduleDeferredCallback(performAsyncWork, { timeout })
}

/**
 * @param isYieldy 是否可以中断
 */
function performWork(minExpirationTime: ExpirationTime, isYieldy: boolean) {
  findHighestPriorityRoot()

  if (isYieldy) {
    // 异步,待实现
  } else { // 同步
    while (nextFlushedRoot !== null && nextFlushedExpirationTime && minExpirationTime <= nextFlushedExpirationTime) {
      performWorkOnRoot(nextFlushedRoot, nextFlushedExpirationTime, false)
      findHighestPriorityRoot()
    }
  }

  // if (isYieldy) {
  //   callbackExpirationTime = NoWork
  //   callbackID = null
  // }

  // finishRendering() // 待实现
}

function performWorkOnRoot(root: FiberRoot, expirationTime: ExpirationTime, isYieldy: boolean) {
  isRendering = true

  let finishedWork: Fiber = root.finishedWork

  if (finishedWork !== null) {
    completeRoot(root, finishedWork, expirationTime)
  } else {
    root.finishedWork = null

    const { timeoutHandle } = root
    if (timeoutHandle !== noTimeout) {
      root.timeoutHandle = noTimeout
      clearTimeout(timeoutHandle)
    }

    renderRoot(root, isYieldy)
    finishedWork = root.finishedWork

    if (finishedWork !== null) {
      if (isYieldy) {
        if (!shouldYield()) {
          completeRoot(root, finishedWork, expirationTime)
        } else {
          root.finishedWork = finishedWork
        }
      } else {
        completeRoot(root, finishedWork, expirationTime)
      }
    }
  }

  isRendering = false
}

function completeRoot(root: FiberRoot, finishedWork: Fiber, expirationTime: ExpirationTime) {
  const { firstBatch } = root
  if (firstBatch !== null && firstBatch._expirationTime >= expirationTime) {
    if (completedBatches === null) {
      completedBatches = [firstBatch]
    } else {
      completedBatches.push(firstBatch)
    }
    if (firstBatch._defer) {
      root.finishedWork = finishedWork
      root.expirationTime = NoWork
      return
    }
  }

  root.finishedWork = null

  if (root === lastCommittedRootDuringThisBatch) {
    nestedUpdateCount++
  } else {
    lastCommittedRootDuringThisBatch = root
    nestedUpdateCount = 0
  }

  commitRoot(root, finishedWork)
}

function commitRoot(root: FiberRoot, finishedWork: Fiber) {
  isWorking = true
  isCommitting = true

  root.pendingCommitExpirationTime = NoWork

  const earliestRemainingTimeBeforeCommit = finishedWork.expirationTime > finishedWork.childExpirationTime ? finishedWork.expirationTime : finishedWork.childExpirationTime

  markCommittedPriorityLevels(root, earliestRemainingTimeBeforeCommit)

  // ReactCurrentOwner.current = null

  let firstEffect: Fiber = null
  if (finishedWork.effectTag > PerformedWork) {
    if (finishedWork.lastEffect !== null) {
      finishedWork.lastEffect.nextEffect = finishedWork
      firstEffect = finishedWork.firstEffect
    } else {
      firstEffect = finishedWork
    }
  } else {
    firstEffect = finishedWork.firstEffect
  }

  // prepareForCommit(root.containerInfo)
  nextEffect = firstEffect
  while (nextEffect !== null) {
    let didError = false
    let error: Error

    try {
      commitBeforeMutationLifecycles()
    } catch (e) {
      didError = true
      error = e
    }
    if (didError) {
      // captureCommitPhaseError(nextEffect, error)

      if (nextEffect !== null) {
        nextEffect = nextEffect.nextEffect
      }
    }
  }

  nextEffect = firstEffect
  while (nextEffect !== null) {
    let didError: boolean = false
    let error: Error

    try {
      commitAllHostEffects()
    } catch (e) {
      didError = true
      error = e
    }

    if (didError) {
      // captureCommitPhaseError(nextEffect, error)

      if (nextEffect !== null) {
        nextEffect = nextEffect.nextEffect
      }
    }
  }

  // resetAfterCommit() // 待实现

  root.current = finishedWork

  nextEffect = firstEffect
  while (nextEffect !== null) {
    let didError = false
    let error: Error

    try {
      commitAllLifeCycles(root)
    } catch (e) {
      didError = true
      error = e
    }
    if (didError) {
      // captureCommitPhaseError(nextEffect, error)

      if (nextEffect !== null) {
        nextEffect = nextEffect.nextEffect
      }
    }
  }

  // 事件操作
  // if (firstEffect !== null && rootWithPendingPassiveEffects !== null) {
  //   // This commit included a passive effect. These do not need to fire until
  //   // after the next paint. Schedule an callback to fire them in an async
  //   // event. To ensure serial execution, the callback will be flushed early if
  //   // we enter rootWithPendingPassiveEffects commit phase before then.
  //   let callback = commitPassiveEffects.bind(null, root, firstEffect);
  //   if (enableSchedulerTracing) {
  //     // TODO: Avoid this extra callback by mutating the tracing ref directly,
  //     // like we do at the beginning of commitRoot. I've opted not to do that
  //     // here because that code is still in flux.
  //     callback = Scheduler_tracing_wrap(callback);
  //   }
  //   passiveEffectCallbackHandle = schedulePassiveEffects(callback);
  //   passiveEffectCallback = callback;
  // }

  isCommitting = false
  isWorking = false

  const earliestRemainingTimeAfterCommit = finishedWork.expirationTime > finishedWork.childExpirationTime ? finishedWork.expirationTime : finishedWork.childExpirationTime

  if (earliestRemainingTimeAfterCommit === NoWork) {
    legacyErrorBoundariesThatAlreadyFailed = null
  }

  root.expirationTime = earliestRemainingTimeAfterCommit
  root.finishedWork = null
}

function commitAllLifeCycles(finishedRoot: FiberRoot) {
  while (nextEffect !== null) {
    const { effectTag } = nextEffect

    if (effectTag & (Update | Callback)) {
      const current = nextEffect.alternate
      commitLifeCycles(current, nextEffect)
    }

    if (effectTag & Ref) {
      commitAttachRef(nextEffect)
    }

    if (effectTag & Passive) {
      rootWithPendingPassiveEffects = finishedRoot
    }
    nextEffect = nextEffect.nextEffect
  }
}

function commitAllHostEffects() {
  while (nextEffect !== null) {
    const { effectTag } = nextEffect

    if (effectTag & ContentReset) {
      commitResetTextContent(nextEffect)
    }

    if (effectTag & Ref) {
      const current = nextEffect.alternate
      if (current !== null) {
        commitDetachRef(nextEffect)
      }
    }

    const primaryEffectTag = effectTag & (Placement | Update | Deletion)
    switch (primaryEffectTag) {
      case Placement: {
        commitPlacement(nextEffect)
        nextEffect.effectTag &= ~Placement // 清除placemenet
        break
      }
      case PlacementAndUpdate: {
        commitPlacement(nextEffect)
        nextEffect.effectTag &= ~Placement

        commitWork(nextEffect.alternate, nextEffect)
        break
      }
      case Update: {
        commitWork(nextEffect.alternate, nextEffect)
        break
      }
      case Deletion: {
        commitDeletion(nextEffect)
        break
      }
    }
    nextEffect = nextEffect.nextEffect
  }
}

function commitBeforeMutationLifecycles() {
  while (nextEffect !== null) {
    const { effectTag } = nextEffect
    if (effectTag & Snapshot) {
      const current = nextEffect.alternate
      commitBeforeMutationLifecycle(current, nextEffect)
    }
    nextEffect = nextEffect.nextEffect
  }
}

function  renderRoot(root: FiberRoot, isYieldy: boolean) {
  // flushPassiveEffects() // 事件相关待实现

  isWorking = true
  //  const previousDispatcher = ReactCurrentDispatcher.current
  // ReactCurrentDispatcher.current = ContextOnlyDispatcher

  const expirationTime = root.nextExpirationTimeToWorkOn

  if (expirationTime !== nextRenderExpirationTime || root !== nextRoot || nextUnitOfWork === null) {
    resetStack()

    nextRoot = root
    nextRenderExpirationTime = expirationTime
    nextUnitOfWork = createWorkInProgress(nextRoot.current, null)
    root.pendingCommitExpirationTime = NoWork
  }

  let didFatal: boolean = false

  do {
    try {
      workLoop(isYieldy)
    } catch (thrownValue) {
      resetContextDependences()
      resetHooks()

      if (nextUnitOfWork === null) {
        // 不可预期的错误
        didFatal = true
        onUncaughtError(thrownValue)
      } else {
        const sourceFiber = nextUnitOfWork
        const returnFiber = sourceFiber.return

        if (returnFiber === null) {
          didFatal = true
          onUncaughtError(thrownValue)
        } else {
          throwException(root, returnFiber, sourceFiber, thrownValue, nextRenderExpirationTime) // 错误处理，没完成
          nextUnitOfWork = completeUnitOfWork(sourceFiber)
          continue
        }
      }
    }
    break
  } while (true)

  isWorking = false
  // ReactCurrentDispatcher.current = previousDispatcher // hook
  resetContextDependences()
  resetHooks() // 待实现

  if (didFatal) {
    nextRoot = null
    root.finishedWork = null
    return
  }

  if (nextUnitOfWork !== null) {
    root.finishedWork = null
    return
  }

  nextRoot = null

  const rootWorkInProgress = root.current.alternate

  if (nextRenderDidError) {
    // 待实现，错误处理
  }

  if (isYieldy) { // 异步待实现
    return
  }

  root.pendingCommitExpirationTime = expirationTime
  root.finishedWork = rootWorkInProgress
}

function workLoop(isYieldy: boolean) {
  if (isYieldy) {
    while (nextUnitOfWork !== null && !shouldYield()) {
      nextUnitOfWork = performUnitOfWork(nextUnitOfWork)
    }
  } else {
    while (nextUnitOfWork !== null) {
      nextUnitOfWork = performUnitOfWork(nextUnitOfWork)
    }
  }
}

function performUnitOfWork(workInProgress: Fiber): Fiber {
  const current = workInProgress.alternate

  let next: Fiber = null

  next = beginWork(current, workInProgress, nextRenderExpirationTime)
  workInProgress.memoizedProps = workInProgress.pendingProps


  if (next === null) {
    next = completeUnitOfWork(workInProgress)
  }

  // ReactCurrentOwner.current = null
  return next
}

function completeUnitOfWork(workInProgress: Fiber): Fiber {
  while (true) {
    const current = workInProgress.alternate
    const returnFiber = workInProgress.return
    const siblingFiber = workInProgress.sibling

    if ((workInProgress.effectTag & Incomplete) === NoEffect) {
      nextUnitOfWork = completeWork(current, workInProgress, nextRenderExpirationTime)
      resetChildExpirationTime(workInProgress, nextRenderExpirationTime)

      if (nextUnitOfWork !== null) {
        return nextUnitOfWork
      }

      if (returnFiber !== null && (returnFiber.effectTag & Incomplete) === NoEffect) {
        if (returnFiber.firstEffect !== null) {
          returnFiber.firstEffect = workInProgress.firstEffect
        }

        if (workInProgress.lastEffect !== null) {
          if (returnFiber.lastEffect !== null) {
            returnFiber.lastEffect.nextEffect = workInProgress.firstEffect
          }
          returnFiber.lastEffect = workInProgress.lastEffect
        }

        const { effectTag } = workInProgress
        if (effectTag > PerformedWork) {
          if (returnFiber.lastEffect !== null) {
            returnFiber.lastEffect.nextEffect = workInProgress
          } else {
            returnFiber.firstEffect = workInProgress
          }
          returnFiber.lastEffect = workInProgress
        }
      }
    } else {
      const next = unwindWork(workInProgress, nextRenderExpirationTime)

      if (next !== null) {
        next.effectTag &= HostEffectMask
        return next
      }

      if (returnFiber !== null) {
        returnFiber.firstEffect = returnFiber.lastEffect = null
        returnFiber.effectTag |= Incomplete
      }
    }

    if (siblingFiber !== null) {
      return siblingFiber
    } else if (returnFiber !== null) {
      workInProgress = returnFiber
      continue
    } else {
      return null
    }
  }
}

export {
  unbatchedUpdates,
  computeExpirationTimeForFiber,
  requestCurrentTime,
  scheduleWork,
}
