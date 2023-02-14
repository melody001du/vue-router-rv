import {
  h,
  inject,
  provide,
  defineComponent,
  PropType,
  ref,
  unref,
  ComponentPublicInstance,
  VNodeProps,
  getCurrentInstance,
  computed,
  AllowedComponentProps,
  ComponentCustomProps,
  watch,
  Slot,
  VNode,
} from 'vue'
import {
  RouteLocationNormalized,
  RouteLocationNormalizedLoaded,
  RouteLocationMatched,
} from './types'
import {
  matchedRouteKey,
  viewDepthKey,
  routerViewLocationKey,
} from './injectionSymbols'
import { assign, isArray, isBrowser } from './utils'
import { warn } from './warning'
import { isSameRouteRecord } from './location'

export interface RouterViewProps {
  name?: string
  // allow looser type for user facing api
  route?: RouteLocationNormalized
}

export interface RouterViewDevtoolsContext
  extends Pick<RouteLocationMatched, 'path' | 'name' | 'meta'> {
  depth: number
}

export const RouterViewImpl = /*#__PURE__*/ defineComponent({
  name: 'RouterView',
  // #674 we manually inherit them
  inheritAttrs: false,
  props: {
    name: {
      type: String as PropType<string>,
      default: 'default',
    },
    route: Object as PropType<RouteLocationNormalizedLoaded>,
  },

  // Better compat for @vue/compat users
  // https://github.com/vuejs/router/issues/1315
  compatConfig: { MODE: 3 },

  setup(props, { attrs, slots }) {
    __DEV__ && warnDeprecatedUsage()
    // currentRoute 信息
    const injectedRoute = inject(routerViewLocationKey)!
    // 当前要展示的路由信息
    const routeToDisplay = computed<RouteLocationNormalizedLoaded>(
      () => props.route || injectedRoute.value
    )
    const injectedDepth = inject(viewDepthKey, 0)

    // 获取匹配的路由记录深度
    const depth = computed<number>(() => {
      let initialDepth = unref(injectedDepth)
      const { matched } = routeToDisplay.value
      let matchedRoute: RouteLocationMatched | undefined
      // 从匹配的路由记录中，查找组件不为空的索引
      while (
        (matchedRoute = matched[initialDepth]) &&
        !matchedRoute.components
      ) {
        initialDepth++
      }
      return initialDepth
    })
    // 获取要展示的路由记录
    const matchedRouteRef = computed<RouteLocationMatched | undefined>(
      () => routeToDisplay.value.matched[depth.value]
    )

    provide(
      viewDepthKey,
      computed(() => depth.value + 1)
    )
    provide(matchedRouteKey, matchedRouteRef)
    provide(routerViewLocationKey, routeToDisplay)

    const viewRef = ref<ComponentPublicInstance>()

    // watch at the same time the component instance, the route record we are
    // rendering, and the name
    // 在组件更新后触发
    watch(
      () => [viewRef.value, matchedRouteRef.value, props.name] as const,
      ([instance, to, name], [oldInstance, from, oldName]) => {
        // copy reused instances
        if (to) {
          // this will update the instance for new instances as well as reused
          // instances when navigating to a new route
          to.instances[name] = instance
          // the component instance is reused for a different route or name, so
          // we copy any saved update or leave guards. With async setup, the
          // mounting component will mount before the matchedRoute changes,
          // making instance === oldInstance, so we check if guards have been
          // added before. This works because we remove guards when
          // unmounting/deactivating components
          // 不同路由记录会复用同一个组件，但是路由记录不同，所以这里拷贝之前路由记录中，如果使用了相同组件的setup中设置的守卫
          if (from && from !== to && instance && instance === oldInstance) {
            if (!to.leaveGuards.size) {
              to.leaveGuards = from.leaveGuards
            }
            if (!to.updateGuards.size) {
              to.updateGuards = from.updateGuards
            }
          }
        }

        // 当监听到viewRef，即组件ref挂载后，调用beforeRouteEnter中next传入的回调，使得回调中能获取到组件实例
        if (
          instance &&
          to &&
          // if there is no instance but to and from are the same this might be
          // the first visit
          (!from || !isSameRouteRecord(to, from) || !oldInstance)
        ) {
          ; (to.enterCallbacks[name] || []).forEach(callback =>
            callback(instance)
          )
        }
      },
      { flush: 'post' } // 组件更新后触发
    )
    // vnode方式创建组件
    return () => {
      const route = routeToDisplay.value
      // we need the value at the time we render because when we unmount, we
      // navigated to a different location so the value is different
      const currentName = props.name
      const matchedRoute = matchedRouteRef.value
      // 获取命名路由，router-view 不传入name,默认为'default'
      const ViewComponent =
        matchedRoute && matchedRoute.components![currentName]
      // 没有匹配到对应路由，啥也不展示
      if (!ViewComponent) {
        return normalizeSlot(slots.default, { Component: ViewComponent, route })
      }

      // 路由配置传递给路由组件的参数
      const routePropsOption = matchedRoute.props[currentName]
      const routeProps = routePropsOption
        ? routePropsOption === true
          ? route.params
          : typeof routePropsOption === 'function'
            ? routePropsOption(route)
            : routePropsOption
        : null

      // onVnodeUnmounted vnode的生命周期，类似的还有：onVnodeBeforeMount ...
      const onVnodeUnmounted: VNodeProps['onVnodeUnmounted'] = vnode => {
        // remove the instance reference to prevent leak
        if (vnode.component!.isUnmounted) {
          matchedRoute.instances[currentName] = null
        }
      }
      // 通过 vnode 格式创建匹配的路由组件
      const component = h(
        ViewComponent, // 第一个参数可以直接传入组件
        assign({}, routeProps, attrs, {
          onVnodeUnmounted,
          ref: viewRef,
        })
      )

      if (
        (__DEV__ || __FEATURE_PROD_DEVTOOLS__) &&
        isBrowser &&
        component.ref
      ) {
        // TODO: can display if it's an alias, its props
        const info: RouterViewDevtoolsContext = {
          depth: depth.value,
          name: matchedRoute.name,
          path: matchedRoute.path,
          meta: matchedRoute.meta,
        }

        const internalInstances = isArray(component.ref)
          ? component.ref.map(r => r.i)
          : [component.ref.i]

        internalInstances.forEach(instance => {
          // @ts-expect-error
          instance.__vrv_devtools = info
        })
      }

      return (
        // pass the vnode to the slot as a prop.
        // h and <component :is="..."> both accept vnodes
        // router-view 是否存在slot内容
        normalizeSlot(slots.default, { Component: component, route }) ||
        component
      )
    }
  },
})
/**
 * 处理这种情况：
 * <router-view v-slot="{ Component, route }">
 *   <transition :name="route.meta.transition">
 *     <component :is="Component" />
 *   </transition>
 * </router-view>
 * 
 * 
 */

// 处理route-view插槽的情况
function normalizeSlot(slot: Slot | undefined, data: any) {
  if (!slot) return null
  // 将data作为props传入，使得外面能通过v-slot获取到，具体查看vue文档的scope slot
  const slotContent = slot(data) //slot()会返回虚拟node, slot.default默认为非命名插槽元素
  return slotContent.length === 1 ? slotContent[0] : slotContent
}

// export the public type for h/tsx inference
// also to avoid inline import() in generated d.ts files
/**
 * Component to display the current route the user is at.
 */
export const RouterView = RouterViewImpl as unknown as {
  new(): {
    $props: AllowedComponentProps &
    ComponentCustomProps &
    VNodeProps &
    RouterViewProps

    $slots: {
      default?: ({
        Component,
        route,
      }: {
        Component: VNode
        route: RouteLocationNormalizedLoaded
      }) => VNode[]
    }
  }
}

// warn against deprecated usage with <transition> & <keep-alive>
// due to functional component being no longer eager in Vue 3
function warnDeprecatedUsage() {
  const instance = getCurrentInstance()!
  const parentName = instance.parent && instance.parent.type.name
  if (
    parentName &&
    (parentName === 'KeepAlive' || parentName.includes('Transition'))
  ) {
    const comp = parentName === 'KeepAlive' ? 'keep-alive' : 'transition'
    warn(
      `<router-view> can no longer be used directly inside <transition> or <keep-alive>.\n` +
      `Use slot props instead:\n\n` +
      `<router-view v-slot="{ Component }">\n` +
      `  <${comp}>\n` +
      `    <component :is="Component" />\n` +
      `  </${comp}>\n` +
      `</router-view>`
    )
  }
}
