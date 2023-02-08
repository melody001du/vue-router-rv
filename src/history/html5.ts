import {
  RouterHistory,
  NavigationCallback,
  NavigationType,
  NavigationDirection,
  HistoryState,
  ValueContainer,
  normalizeBase,
  createHref,
  HistoryLocation,
} from './common'
import {
  computeScrollPosition,
  _ScrollPositionNormalized,
} from '../scrollBehavior'
import { warn } from '../warning'
import { stripBase } from '../location'
import { assign } from '../utils'

type PopStateListener = (this: Window, ev: PopStateEvent) => any

let createBaseLocation = () => location.protocol + '//' + location.host

interface StateEntry extends HistoryState {
  back: HistoryLocation | null
  current: HistoryLocation
  forward: HistoryLocation | null
  position: number
  replaced: boolean
  scroll: _ScrollPositionNormalized | null | false
}

/**
 * Creates a normalized history location from a window.location object
 * @param location -
 */
// 根据当前window.location和base，返回处理后没有域名以及base后的完整url
function createCurrentLocation(
  base: string,
  location: Location
): HistoryLocation {
  const { pathname, search, hash } = location
  // allows hash bases like #, /#, #/, #!, #!/, /#!/, or even /folder#end
  const hashPos = base.indexOf('#')
  if (hashPos > -1) {
    let slicePos = hash.includes(base.slice(hashPos))
      ? base.slice(hashPos).length
      : 1
    // hash # 后的内容
    let pathFromHash = hash.slice(slicePos)
    // prepend the starting slash to hash so the url starts with /#
    if (pathFromHash[0] !== '/') pathFromHash = '/' + pathFromHash
    // 去掉pathname中包含的base 
    return stripBase(pathFromHash, '')
  }
  const path = stripBase(pathname, base)
  return path + search + hash
}

// 创建路由改变时的监听、订阅功能
function useHistoryListeners(
  base: string,
  historyState: ValueContainer<StateEntry>,
  currentLocation: ValueContainer<HistoryLocation>,
  replace: RouterHistory['replace']
) {
  let listeners: NavigationCallback[] = []
  let teardowns: Array<() => void> = []
  // TODO: should it be a stack? a Dict. Check if the popstate listener
  // can trigger twice
  let pauseState: HistoryLocation | null = null

  const popStateHandler: PopStateListener = ({
    state,
  }: {
    state: StateEntry | null
  }) => {
    // 返回去掉base路径后的window.loaction的url
    const to = createCurrentLocation(base, location)
    const from: HistoryLocation = currentLocation.value
    const fromState: StateEntry = historyState.value
    let delta = 0
    // 更新最新路由信息
    if (state) {
      currentLocation.value = to
      historyState.value = state

      // ignore the popstate and reset the pauseState
      if (pauseState && pauseState === from) {
        pauseState = null
        return
      }
      delta = fromState ? state.position - fromState.position : 0
    } else {
      replace(to)
    }

    // console.log({ deltaFromCurrent })
    // Here we could also revert the navigation by calling history.go(-delta)
    // this listener will have to be adapted to not trigger again and to wait for the url
    // to be updated before triggering the listeners. Some kind of validation function would also
    // need to be passed to the listeners so the navigation can be accepted
    // call all listeners
    // 路由记录改变后触发监听,在setupListeners中会添加回调，对于history路由浏览器前进后退时触发导航
    listeners.forEach(listener => {
      listener(currentLocation.value, from, {
        delta,
        type: NavigationType.pop,  // 监听popstate
        direction: delta
          ? delta > 0
            ? NavigationDirection.forward
            : NavigationDirection.back
          : NavigationDirection.unknown,
      })
    })
  }
  // 调用后popstate不触发listeners监听
  function pauseListeners() {
    pauseState = currentLocation.value
  }

  // 添加监听
  function listen(callback: NavigationCallback) {
    // set up the listener and prepare teardown callbacks
    listeners.push(callback)

    const teardown = () => {
      const index = listeners.indexOf(callback)
      if (index > -1) listeners.splice(index, 1)
    }

    teardowns.push(teardown)
    return teardown
  }
  // 在页面将要卸载时，保存一下路由状态
  function beforeUnloadListener() {
    const { history } = window
    if (!history.state) return
    // 第三个参数不传，那么就只更新state
    history.replaceState(
      assign({}, history.state, { scroll: computeScrollPosition() }),
      ''
    )
  }
  // 清除监听
  function destroy() {
    for (const teardown of teardowns) teardown()
    teardowns = []
    window.removeEventListener('popstate', popStateHandler)
    window.removeEventListener('beforeunload', beforeUnloadListener)
  }

  // set up the listeners and prepare teardown callbacks
  window.addEventListener('popstate', popStateHandler)

  // https://developer.chrome.com/blog/page-lifecycle-api/
  // 当浏览器窗口，文档或其资源将要卸载时，会触发beforeunload事件
  window.addEventListener('beforeunload', beforeUnloadListener, {
    passive: true, //表示 listener 永远不会调用 preventDefault()
  })

  return {
    pauseListeners,
    listen,
    destroy,
  }
}

/**
 * Creates a state object
 */
// 返回路由统一规定格式的对象
function buildState(
  back: HistoryLocation | null,
  current: HistoryLocation,
  forward: HistoryLocation | null,
  replaced: boolean = false,
  computeScroll: boolean = false
): StateEntry {
  return {
    back,
    current,
    forward,
    replaced,
    position: window.history.length,
    scroll: computeScroll ? computeScrollPosition() : null,
  }
}
// 创建导航信息，以及导航相关api
function useHistoryStateNavigation(base: string) {
  const { history, location } = window

  // private variables
  const currentLocation: ValueContainer<HistoryLocation> = {
    // 返回去掉base路径后的loaction的url
    value: createCurrentLocation(base, location),
  }
  const historyState: ValueContainer<StateEntry> = { value: history.state }
  // build current history entry as this is a fresh navigation
  if (!historyState.value) {
    changeLocation(
      currentLocation.value,
      {
        back: null,
        current: currentLocation.value,
        forward: null,
        // the length is off by one, we need to decrease it
        position: history.length - 1,
        replaced: true,
        // don't add a scroll as the user may have an anchor, and we want
        // scrollBehavior to be triggered without a saved position
        scroll: null,
      },
      true
    )
  }

  /**
   * 通过history路由进行更改url和存储导航信息
   * 如果报错，则使用locatio方法直接更改url
   */
  function changeLocation(
    to: HistoryLocation,
    state: StateEntry,
    replace: boolean
  ): void {
    /**
     * if a base tag is provided, and we are on a normal domain, we have to
     * respect the provided `base` attribute because pushState() will use it and
     * potentially  anything before the `#` like at
     * https://github.com/vuejs/router/issues/685 where aerase base of
     * `/folder/#` but a base of `/` would erase the `/folder/` section. If
     * there is no host, the `<base>` tag makes no sense and if there isn't a
     * base tag we can just use everything after the `#`.
     */
    /**
     * 如果有<base />标签，优先使用<base />标签提供的base路径
     * 如果没有，传入的base中有#，pushState会潜在的去掉#之前的内容，/folder/#` => `/`
     */
    const hashIndex = base.indexOf('#')
    const url =
      hashIndex > -1
        ? (location.host && document.querySelector('base')
          ? base
          : base.slice(hashIndex)) + to
        : createBaseLocation() + base + to //createBaseLocation：通过window.location拼接的域名

    try {
      // BROWSER QUIRK
      // NOTE: Safari throws a SecurityError when calling this function 100 times in 30 seconds
      history[replace ? 'replaceState' : 'pushState'](state, '', url)
      historyState.value = state
    } catch (err) {
      if (__DEV__) {
        warn('Error with push/replace State', err)
      } else {
        console.error(err)
      }
      // Force the navigation, this also resets the call count
      // location.assign() 方法会触发窗口加载并显示指定的 URL 的内容。
      location[replace ? 'replace' : 'assign'](url)
    }
  }

  // replace方法，最终调用changeLocation进行url更改
  function replace(to: HistoryLocation, data?: HistoryState) {
    const state: StateEntry = assign(
      {},
      history.state,
      // 将传入的参数变成对象返回
      buildState(
        historyState.value.back,
        // keep back and forward entries but override current position
        to,
        historyState.value.forward,
        true  //调用replace
      ),
      data,
      { position: historyState.value.position }
    )

    changeLocation(to, state, true)
    currentLocation.value = to
  }

  /**
   * push的时候会增加两条记录
   * 第一条：旧导航信息，将forward变成将要去到的路径
   * 第二条：最新的导航信息，back为要离开的路径，current为当前路径，forward为null
   */
  function push(to: HistoryLocation, data?: HistoryState) {
    // Add to current entry the information of where we are going
    // as well as saving the current position

    // 旧信息，添加forward指向将要去到的路径，以及保存页面滚动坐标
    const currentState = assign(
      {},
      // use current history state to gracefully handle a wrong call to
      // history.replaceState
      // https://github.com/vuejs/router/issues/366
      historyState.value,
      history.state as Partial<StateEntry> | null,
      {
        forward: to,
        scroll: computeScrollPosition(), //返回window.pageXOffset等相关的坐标信息
      }
    )

    if (__DEV__ && !history.state) {
      warn(
        `history.state seems to have been manually replaced without preserving the necessary values. Make sure to preserve existing history state if you are manually calling history.replaceState:\n\n` +
        `history.replaceState(history.state, '', url)\n\n` +
        `You can find more information at https://next.router.vuejs.org/guide/migration/#usage-of-history-state.`
      )
    }
    // 添加记录
    changeLocation(currentState.current, currentState, true)

    // 新信息，buildState中添加back指向之前路径，to为current路径，forward为null
    const state: StateEntry = assign(
      {},
      buildState(currentLocation.value, to, null),
      { position: currentState.position + 1 },
      data
    )

    changeLocation(to, state, false)
    // 更新当前location
    currentLocation.value = to
  }

  return {
    location: currentLocation,
    state: historyState,

    push,
    replace,
  }
}

/**
 * Creates an HTML5 history. Most common history for single page applications.
 *
 * @param base -
 */
export function createWebHistory(base?: string): RouterHistory {
  /**
   * 如果没有传入base，则取html文档中<base />,会将域名后第一个斜杠之前的内容全部去除
   * 如果传入了base，若开头没有'/',则添加'/'前缀
   * 最后去掉尾部的'/'
   */
  base = normalizeBase(base)
  // 创建导航信息，以及导航相关api
  const historyNavigation = useHistoryStateNavigation(base)
  // 创建路由改变时的监听、订阅功能
  // 虽然popstate不能监听history.pushState,但不管是通过history.pushState或者通过popstate监听,都只要保证路由信息正确即可,不一定需要监听pushState
  const historyListeners = useHistoryListeners(
    base,
    historyNavigation.state,
    historyNavigation.location,
    historyNavigation.replace
  )

  // 包装history.go API，添加停止触发popstate后的listeners
  function go(delta: number, triggerListeners = true) {
    if (!triggerListeners) historyListeners.pauseListeners()
    history.go(delta)
  }

  // 最终整合返回给外部调用的API
  const routerHistory: RouterHistory = assign(
    {
      // it's overridden right after
      location: '',
      base,
      go,
      createHref: createHref.bind(null, base), // 删除掉 # 之前的所有内容
    },

    historyNavigation,
    historyListeners
  )

  // 通过Object.defineProperty劫持，保证时刻返回最新的路由信息
  Object.defineProperty(routerHistory, 'location', {
    enumerable: true,
    get: () => historyNavigation.location.value,
  })

  Object.defineProperty(routerHistory, 'state', {
    enumerable: true,
    get: () => historyNavigation.state.value,
  })

  return routerHistory
}
