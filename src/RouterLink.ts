import {
  defineComponent,
  h,
  PropType,
  inject,
  computed,
  reactive,
  unref,
  VNode,
  UnwrapRef,
  VNodeProps,
  AllowedComponentProps,
  ComponentCustomProps,
  getCurrentInstance,
  watchEffect,
  // this is a workaround for https://github.com/microsoft/rushstack/issues/1050
  // this file is meant to be prepended to the generated dist/src/RouterLink.d.ts
  // @ts-ignore
  ComputedRef,
  // @ts-ignore
  DefineComponent,
  // @ts-ignore
  RendererElement,
  // @ts-ignore
  RendererNode,
  // @ts-ignore
  ComponentOptionsMixin,
} from 'vue'
import {
  RouteLocationRaw,
  VueUseOptions,
  RouteLocation,
  RouteLocationNormalized,
} from './types'
import { isSameRouteLocationParams, isSameRouteRecord } from './location'
import { routerKey, routeLocationKey } from './injectionSymbols'
import { RouteRecord } from './matcher/types'
import { NavigationFailure } from './errors'
import { isArray, isBrowser, noop } from './utils'

export interface RouterLinkOptions {
  /**
   * Route Location the link should navigate to when clicked on.
   */
  to: RouteLocationRaw
  /**
   * Calls `router.replace` instead of `router.push`.
   */
  replace?: boolean
  // TODO: refactor using extra options allowed in router.push. Needs RFC
}

export interface RouterLinkProps extends RouterLinkOptions {
  /**
   * Whether RouterLink should not wrap its content in an `a` tag. Useful when
   * using `v-slot` to create a custom RouterLink
   */
  custom?: boolean
  /**
   * Class to apply when the link is active
   */
  activeClass?: string
  /**
   * Class to apply when the link is exact active
   */
  exactActiveClass?: string
  /**
   * Value passed to the attribute `aria-current` when the link is exact active.
   *
   * @defaultValue `'page'`
   */
  ariaCurrentValue?:
  | 'page'
  | 'step'
  | 'location'
  | 'date'
  | 'time'
  | 'true'
  | 'false'
}

export interface UseLinkDevtoolsContext {
  route: RouteLocationNormalized & { href: string }
  isActive: boolean
  isExactActive: boolean
}

export type UseLinkOptions = VueUseOptions<RouterLinkOptions>

// TODO: we could allow currentRoute as a prop to expose `isActive` and
// `isExactActive` behavior should go through an RFC
export function useLink(props: UseLinkOptions) {
  // 在install中提供的symbol,获取到暴露的router信息
  const router = inject(routerKey)!
  // currentRoute始终指向当前页面路由信息
  const currentRoute = inject(routeLocationKey)!
  // 路由匹配，并返回解析结果
  const route = computed(() => router.resolve(unref(props.to)))

  // 返回当前页面路由记录的index
  const activeRecordIndex = computed<number>(() => {
    // 根据传递的参数to获取路由匹配记录
    const { matched } = route.value
    const { length } = matched
    const routeMatched: RouteRecord | undefined = matched[length - 1]
    // 当前页面路由匹配记录
    const currentMatched = currentRoute.matched
    if (!routeMatched || !currentMatched.length) return -1
    const index = currentMatched.findIndex(
      isSameRouteRecord.bind(null, routeMatched)
    )
    if (index > -1) return index
    // possible parent record
    // 获取路由记录的path
    const parentRecordPath = getOriginalPath(
      matched[length - 2] as RouteRecord | undefined
    )
    return (
      // we are dealing with nested routes
      length > 1 &&
        // if the parent and matched route have the same path, this link is
        // referring to the empty child. Or we currently are on a different
        // child of the same parent
        getOriginalPath(routeMatched) === parentRecordPath &&
        // avoid comparing the child with its parent
        currentMatched[currentMatched.length - 1].path !== parentRecordPath
        ? currentMatched.findIndex(
          isSameRouteRecord.bind(null, matched[length - 2])
        )
        : index
    )
  })
  // 当前路由以及父路径上的路由都会active
  const isActive = computed<boolean>(
    () =>
      activeRecordIndex.value > -1 &&
      includesParams(currentRoute.params, route.value.params)
  )
  // 精确匹配，只有当前路由会active
  const isExactActive = computed<boolean>(
    () =>
      activeRecordIndex.value > -1 &&
      activeRecordIndex.value === currentRoute.matched.length - 1 &&
      isSameRouteLocationParams(currentRoute.params, route.value.params)
  )

  function navigate(
    e: MouseEvent = {} as MouseEvent
  ): Promise<void | NavigationFailure> {
    // 阻止原生事件的一些默认行为
    if (guardEvent(e)) {
      return router[unref(props.replace) ? 'replace' : 'push'](
        unref(props.to)
        // avoid uncaught errors are they are logged anyway
      ).catch(noop)
    }
    return Promise.resolve()
  }

  // devtools only
  if ((__DEV__ || __FEATURE_PROD_DEVTOOLS__) && isBrowser) {
    const instance = getCurrentInstance()
    if (instance) {
      const linkContextDevtools: UseLinkDevtoolsContext = {
        route: route.value,
        isActive: isActive.value,
        isExactActive: isExactActive.value,
      }

      // @ts-expect-error: this is internal
      instance.__vrl_devtools = instance.__vrl_devtools || []
      // @ts-expect-error: this is internal
      instance.__vrl_devtools.push(linkContextDevtools)
      watchEffect(
        () => {
          linkContextDevtools.route = route.value
          linkContextDevtools.isActive = isActive.value
          linkContextDevtools.isExactActive = isExactActive.value
        },
        { flush: 'post' }
      )
    }
  }

  /**
   * NOTE: update {@link _RouterLinkI}'s `$slots` type when updating this
   */
  return {
    route,
    href: computed(() => route.value.href),
    isActive,
    isExactActive,
    navigate,
  }
}

// router-link组件，默认是一个包装了a标签的组件
export const RouterLinkImpl = /*#__PURE__*/ defineComponent({
  name: 'RouterLink',
  compatConfig: { MODE: 3 },
  props: {
    to: {
      type: [String, Object] as PropType<RouteLocationRaw>,
      required: true,
    },
    replace: Boolean,
    activeClass: String,
    // inactiveClass: String,
    exactActiveClass: String,
    custom: Boolean,
    ariaCurrentValue: {
      type: String as PropType<RouterLinkProps['ariaCurrentValue']>,
      default: 'page',
    },
  },

  useLink,

  setup(props, { slots }) {
    const link = reactive(useLink(props))
    // options 为 createRouter传入的options
    const { options } = inject(routerKey)!
    // 处理路由高亮的class
    const elClass = computed(() => ({
      [getLinkClass(
        props.activeClass,
        options.linkActiveClass,
        'router-link-active'
      )]: link.isActive,
      // [getLinkClass(
      //   props.inactiveClass,
      //   options.linkInactiveClass,
      //   'router-link-inactive'
      // )]: !link.isExactActive,
      [getLinkClass(
        props.exactActiveClass,
        options.linkExactActiveClass,
        'router-link-exact-active'
      )]: link.isExactActive,
    }))

    return () => {
      // 获取子组件，并将link信息传入props
      const children = slots.default && slots.default(link)
      return props.custom
        ? children
        : h(
          'a',
          {
            'aria-current': link.isExactActive
              ? props.ariaCurrentValue
              : null,
            href: link.href,
            // this would override user added attrs but Vue will still add
            // the listener, so we end up triggering both
            onClick: link.navigate,
            class: elClass.value,
          },
          children
        )
    }
  },
})

// export the public type for h/tsx inference
// also to avoid inline import() in generated d.ts files
/**
 * Component to render a link that triggers a navigation on click.
 */
export const RouterLink: _RouterLinkI = RouterLinkImpl as any

/**
 * Typed version of the `RouterLink` component. Its generic defaults to the typed router, so it can be inferred
 * automatically for JSX.
 *
 * @internal
 */
export interface _RouterLinkI {
  new(): {
    $props: AllowedComponentProps &
    ComponentCustomProps &
    VNodeProps &
    RouterLinkProps

    $slots: {
      default?: ({
        route,
        href,
        isActive,
        isExactActive,
        navigate,
      }: UnwrapRef<ReturnType<typeof useLink>>) => VNode[]
    }
  }

  /**
   * Access to `useLink()` without depending on using vue-router
   *
   * @internal
   */
  useLink: typeof useLink
}

function guardEvent(e: MouseEvent) {
  // don't redirect with control keys
  if (e.metaKey || e.altKey || e.ctrlKey || e.shiftKey) return
  // 表明当前事件是否调用了 event.preventDefault()方法。
  if (e.defaultPrevented) return
  // don't redirect on right click
  if (e.button !== undefined && e.button !== 0) return
  // don't redirect if `target="_blank"`
  // @ts-expect-error getAttribute does exist
  if (e.currentTarget && e.currentTarget.getAttribute) {
    // @ts-expect-error getAttribute exists
    const target = e.currentTarget.getAttribute('target')
    if (/\b_blank\b/i.test(target)) return
  }
  // this may be a Weex event which doesn't have this method
  if (e.preventDefault) e.preventDefault()

  return true
}

function includesParams(
  outer: RouteLocation['params'],
  inner: RouteLocation['params']
): boolean {
  for (const key in inner) {
    const innerValue = inner[key]
    const outerValue = outer[key]
    if (typeof innerValue === 'string') {
      if (innerValue !== outerValue) return false
    } else {
      if (
        !isArray(outerValue) ||
        outerValue.length !== innerValue.length ||
        innerValue.some((value, i) => value !== outerValue[i])
      )
        return false
    }
  }

  return true
}

/**
 * Get the original path value of a record by following its aliasOf
 * @param record
 */
function getOriginalPath(record: RouteRecord | undefined): string {
  return record ? (record.aliasOf ? record.aliasOf.path : record.path) : ''
}

/**
 * Utility class to get the active class based on defaults.
 * @param propClass
 * @param globalClass
 * @param defaultClass
 */
const getLinkClass = (
  propClass: string | undefined,
  globalClass: string | undefined,
  defaultClass: string
): string =>
  propClass != null
    ? propClass
    : globalClass != null
      ? globalClass
      : defaultClass
