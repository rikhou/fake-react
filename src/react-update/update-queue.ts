import { Fiber } from '../react-fiber/fiber'
import Update from './update'

export class UpdateQueue<State> {
  baseState: State

  firstUpdate: Update<State> = null
  lastUpdate: Update<State> = null

  firstCapturedUpdate: Update<State> = null
  lastCapturedUpdate: Update<State> = null

  firstEffect: Update<State> = null
  lastEffect: Update<State> = null

  firstCapturedEffect: Update<State> = null
  lastCapturedEffect: Update<State> = null

  constructor(baseState: State) {
    this.baseState = baseState
  }
}

function cloneUpdateQueue<State>(queue: UpdateQueue<State>): UpdateQueue<State> {
  const updateQueue = new UpdateQueue<State>(queue.baseState)
  updateQueue.firstUpdate = queue.firstUpdate
  updateQueue.lastUpdate = queue.lastUpdate

  return updateQueue
}

function appendUpdateToQueue<State>(queue: UpdateQueue<State>, update: Update<State>) {
  if (queue.lastUpdate === null) {
    queue.firstUpdate = queue.lastUpdate = null
  } else {
    queue.lastUpdate.next = update
    queue.lastUpdate = update
  }
}

export function enqueueUpdate<State>(fiber: Fiber, update: Update<State>) {
  const { alternate } = fiber

  let queue1: UpdateQueue<State>
  let queue2: UpdateQueue<State>

  if (alternate === null) {
    queue1 = fiber.updateQueue
    queue2 = null

    if (queue1 === null) {
      queue1 = fiber.updateQueue = new UpdateQueue(fiber.memoizedState)
    }
  } else {
    queue1 = fiber.updateQueue
    queue2 = alternate.updateQueue

    if (queue1 === null && queue2 === null) {
      queue1 = fiber.updateQueue = new UpdateQueue(fiber.memoizedState)
      queue2 = alternate.updateQueue = new UpdateQueue(alternate.memoizedState)
    } else if (queue1 !== null && queue2 === null) {
      queue2 = alternate.updateQueue = cloneUpdateQueue(queue1)
    } else if (queue1 === null && queue2 !== null) {
      queue1 = fiber.updateQueue = cloneUpdateQueue(queue2)
    }
  }

  if (queue2 === null || queue1 === queue2) {
    appendUpdateToQueue(queue1, update)
  } else if (queue1 === null || queue2 === null) {
    appendUpdateToQueue(queue1, update)
    appendUpdateToQueue(queue2, update)
  } else {
    // 两个队列都不为空，它们的last update是相同的
    appendUpdateToQueue(queue1, update)
    queue2.lastUpdate = update
  }
}





