import { AnyNativeEvent, DispatchConfig, PluginModule } from '../react-type/event-type'

type PluginName = string

interface NamesToPlugins {
  [key: string]: PluginModule<AnyNativeEvent>
}
// 以插件名为key的插件map
const namesToPlugins: NamesToPlugins = {}

// 记录插件的调用顺序
let eventPluginOrder: PluginName[] = null

// event plugin modules
export const registrationNameModules = {} // 存储 包含phasedRegistrationNames或者registrationName 的 plugin
export const registrationNameDependencies = {} // 存储 包含phasedRegistrationNames或者registrationName 的 Plugin 中 eventTypes.dependencies
export const plugins: Array<PluginModule<AnyNativeEvent>> = [] // 按照eventPluginOrder 顺序存储的 plugin

function publishRegistrationName(registrationName: string, pluginModule: PluginModule<AnyNativeEvent>, eventName: string) {
  registrationNameModules[registrationName] = pluginModule
  registrationNameDependencies[registrationName] = pluginModule.eventTypes[eventName].dependencies
}

function publishEventForPlugin(dispatchConfig: DispatchConfig, pluginModule: PluginModule<AnyNativeEvent>, eventName: string) {
  const { phasedRegistrationNames, registrationName } = dispatchConfig
  if (phasedRegistrationNames) {
    for (const phasedName in phasedRegistrationNames) {
      const phasedRegistrationName = phasedRegistrationNames[phasedName]
      publishRegistrationName(phasedRegistrationName, pluginModule, eventName)
    }
  } else if (registrationName) {
    publishRegistrationName(registrationName, pluginModule, eventName)
  }
}

function recomputePluginOrdering() {
  if (!eventPluginOrder) {
    return
  }

  for (const pluginName in namesToPlugins) {
    const pluginModule = namesToPlugins[pluginName]
    const pluginIndex = eventPluginOrder.indexOf(pluginName)

    if (plugins[pluginIndex]) {
      continue
    }

    plugins[pluginIndex] = pluginModule

    const publishedEvents = pluginModule.eventTypes
    for (const eventName in publishedEvents) {
      publishEventForPlugin(publishedEvents[eventName], pluginModule, eventName)
    }
  }
}

function injectEventPluginOrder(injectEventPluginOrders: PluginName[]) {
  eventPluginOrder = [...injectEventPluginOrders]
  recomputePluginOrdering()
}

function injectEventPluginsByName(injectedNamesToPlugins: NamesToPlugins) {
  let isOrderingDirty: boolean = false
  for (const pluginName in injectedNamesToPlugins) {
    const pluginModule = injectedNamesToPlugins[pluginName]

    if (!namesToPlugins.hasOwnProperty(pluginName) || namesToPlugins[pluginName] !== pluginModule) {
      namesToPlugins[pluginName] = pluginModule
      isOrderingDirty = true
    }
  }
  if (isOrderingDirty) {
    recomputePluginOrdering()
  }
}

export {
  injectEventPluginOrder,
  injectEventPluginsByName,
}


