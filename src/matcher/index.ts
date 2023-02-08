import {
  RouteRecordRaw,
  MatcherLocationRaw,
  MatcherLocation,
  isRouteName,
  RouteRecordName,
  _RouteRecordProps,
} from '../types'
import { createRouterError, ErrorTypes, MatcherError } from '../errors'
import { createRouteRecordMatcher, RouteRecordMatcher } from './pathMatcher'
import { RouteRecordNormalized } from './types'

import type {
  PathParams,
  PathParserOptions,
  _PathParserOptions,
} from './pathParserRanker'

import { comparePathParserScore } from './pathParserRanker'

import { warn } from '../warning'
import { assign, noop } from '../utils'

/**
 * Internal RouterMatcher
 *
 * @internal
 */
export interface RouterMatcher {
  addRoute: (record: RouteRecordRaw, parent?: RouteRecordMatcher) => () => void
  removeRoute: {
    (matcher: RouteRecordMatcher): void
    (name: RouteRecordName): void
  }
  getRoutes: () => RouteRecordMatcher[]
  getRecordMatcher: (name: RouteRecordName) => RouteRecordMatcher | undefined

  /**
   * Resolves a location. Gives access to the route record that corresponds to the actual path as well as filling the corresponding params objects
   *
   * @param location - MatcherLocationRaw to resolve to a url
   * @param currentLocation - MatcherLocation of the current location
   */
  resolve: (
    location: MatcherLocationRaw,
    currentLocation: MatcherLocation
  ) => MatcherLocation
}

/**
 * Creates a Router Matcher.
 *
 * @internal
 * @param routes - array of initial routes
 * @param globalOptions - global route options
 */
export function createRouterMatcher(
  routes: Readonly<RouteRecordRaw[]>,
  globalOptions: PathParserOptions
): RouterMatcher {
  // 存储匹配的路由记录（会包括父路由记录）
  const matchers: RouteRecordMatcher[] = []
  // 存储原始路由记录（非原始记录：别名路由会再创建一条记录）
  const matcherMap = new Map<RouteRecordName, RouteRecordMatcher>()
  //合并第一个参数的key
  globalOptions = mergeOptions(
    { strict: false, end: true, sensitive: false } as PathParserOptions,
    globalOptions
  )

  function getRecordMatcher(name: RouteRecordName) {
    return matcherMap.get(name)
  }

  function addRoute(
    record: RouteRecordRaw,
    parent?: RouteRecordMatcher,
    originalRecord?: RouteRecordMatcher // 别名路由对应的原始记录
  ) {
    // 首次添加originalRecord为空，表面是添加第一层根路由
    const isRootAdd = !originalRecord
    // 将单个路由配置转换成规定格式
    // 单个component统一转换成components:{default:A}
    const mainNormalizedRecord = normalizeRouteRecord(record)
    if (__DEV__) {
      // 有名称的父路由如果添加没有名称和空路径的子路由发出警告
      checkChildMissingNameWithEmptyPath(mainNormalizedRecord, parent)
    }
    // we might be the child of an alias
    mainNormalizedRecord.aliasOf = originalRecord && originalRecord.record
    const options: PathParserOptions = mergeOptions(globalOptions, record)
    // 将转换后的路由变成数组格式，将别名记录添加进去
    const normalizedRecords: typeof mainNormalizedRecord[] = [
      mainNormalizedRecord,
    ]
    if ('alias' in record) {
      // 别名可以是一个字符串或数组，统一变成数组格式
      const aliases =
        typeof record.alias === 'string' ? [record.alias] : record.alias!
      // 将alias变成path,有多少个alias就会添加多少条记录
      for (const alias of aliases) {
        normalizedRecords.push(
          assign({}, mainNormalizedRecord, {
            // this allows us to hold a copy of the `components` option
            // so that async components cache is hold on the original record
            components: originalRecord
              ? originalRecord.record.components
              : mainNormalizedRecord.components,
            path: alias,
            // we might be the child of an alias
            // 别名路由指向的原始路由记录
            aliasOf: originalRecord
              ? originalRecord.record
              : mainNormalizedRecord,
            // the aliases are always of the same kind as the original since they
            // are defined on the same record
          }) as typeof mainNormalizedRecord
        )
      }
    }

    let matcher: RouteRecordMatcher
    let originalMatcher: RouteRecordMatcher | undefined

    for (const normalizedRecord of normalizedRecords) {
      const { path } = normalizedRecord

      // 添加子路由：处理alias没有加'/',且父路由没有以'/'结尾的情况,会拼接父路由路径作为path
      if (parent && path[0] !== '/') {
        const parentPath = parent.record.path
        const connectingSlash =
          parentPath[parentPath.length - 1] === '/' ? '' : '/'
        normalizedRecord.path =
          parent.record.path + (path && connectingSlash + path)
      }

      // 现在的版本必须用正则代替'*'匹配所有路由
      if (__DEV__ && normalizedRecord.path === '*') {
        throw new Error(
          'Catch all routes ("*") must now be defined using a param with a custom regexp.\n' +
          'See more at https://next.router.vuejs.org/guide/migration/#removed-star-or-catch-all-routes.'
        )
      }

      // create the object beforehand, so it can be passed to children
      matcher = createRouteRecordMatcher(normalizedRecord, parent, options)

      if (__DEV__ && parent && path[0] === '/')
        checkMissingParamsInAbsolutePath(matcher, parent)

      // if we are an alias we must tell the original record that we exist,
      // so we can be removed
      // 当设置了别名alias,会再次生成一条别名对路由记录
      // 当第一次遍历原始路由记录后,originalRecord为上次原始记录,将别名路由记录放进原始记录的alias中
      if (originalRecord) {
        originalRecord.alias.push(matcher)
        if (__DEV__) {
          checkSameParams(originalRecord, matcher)
        }
      } else {
        // otherwise, the first record is the original and others are aliases
        originalMatcher = originalMatcher || matcher
        if (originalMatcher !== matcher) originalMatcher.alias.push(matcher)

        // remove the route if named and only for the top record (avoid in nested calls)
        // this works because the original record is the first one
        // 对于第一层路由，并且是设置了name的命名路由，每次添加后会先删除掉之前添加的name路由，相当于覆盖操作
        if (isRootAdd && record.name && !isAliasRecord(matcher))
          removeRoute(record.name)
      }

      if (mainNormalizedRecord.children) {
        const children = mainNormalizedRecord.children
        for (let i = 0; i < children.length; i++) {
          addRoute(
            children[i],
            matcher,
            originalRecord && originalRecord.children[i]
          )
        }
      }

      // if there was no original record, then the first one was not an alias and all
      // other aliases (if any) need to reference this record when adding children
      originalRecord = originalRecord || matcher

      // TODO: add normalized records for more flexibility
      // if (parent && isAliasRecord(originalRecord)) {
      //   parent.children.push(originalRecord)
      // }

      // Avoid adding a record that doesn't display anything. This allows passing through records without a component to
      // not be reached and pass through the catch all route
      if (
        (matcher.record.components &&
          Object.keys(matcher.record.components).length) ||
        matcher.record.name ||
        matcher.record.redirect
      ) {
        insertMatcher(matcher)
      }
    }

    return originalMatcher
      ? () => {
        // since other matchers are aliases, they should be removed by the original matcher
        removeRoute(originalMatcher!)
      }
      : noop
  }

  function removeRoute(matcherRef: RouteRecordName | RouteRecordMatcher) {
    if (isRouteName(matcherRef)) {
      const matcher = matcherMap.get(matcherRef)
      if (matcher) {
        matcherMap.delete(matcherRef)
        matchers.splice(matchers.indexOf(matcher), 1)
        matcher.children.forEach(removeRoute)
        matcher.alias.forEach(removeRoute)
      }
    } else {
      const index = matchers.indexOf(matcherRef)
      if (index > -1) {
        matchers.splice(index, 1)
        if (matcherRef.record.name) matcherMap.delete(matcherRef.record.name)
        matcherRef.children.forEach(removeRoute)
        matcherRef.alias.forEach(removeRoute)
      }
    }
  }

  function getRoutes() {
    return matchers
  }

  function insertMatcher(matcher: RouteRecordMatcher) {
    let i = 0
    // 对路由记录根据score进行排序，i代表该路由记录排序后的位置
    while (
      i < matchers.length &&
      comparePathParserScore(matcher, matchers[i]) >= 0 &&
      // Adding children with empty path should still appear before the parent
      // https://github.com/vuejs/router/issues/1124
      (matcher.record.path !== matchers[i].record.path ||
        !isRecordChildOf(matcher, matchers[i]))
    )
      i++
    // 将路由记录插入matchers中
    matchers.splice(i, 0, matcher)
    // only add the original record to the name map
    if (matcher.record.name && !isAliasRecord(matcher))
      matcherMap.set(matcher.record.name, matcher)
  }

  function resolve(
    location: Readonly<MatcherLocationRaw>,
    currentLocation: Readonly<MatcherLocation>
  ): MatcherLocation {
    let matcher: RouteRecordMatcher | undefined
    let params: PathParams = {}
    let path: MatcherLocation['path']
    let name: MatcherLocation['name']

    if ('name' in location && location.name) {
      matcher = matcherMap.get(location.name)

      if (!matcher)
        throw createRouterError<MatcherError>(ErrorTypes.MATCHER_NOT_FOUND, {
          location,
        })

      // warn if the user is passing invalid params so they can debug it better when they get removed
      if (__DEV__) {
        const invalidParams: string[] = Object.keys(
          location.params || {}
        ).filter(paramName => !matcher!.keys.find(k => k.name === paramName))

        if (invalidParams.length) {
          warn(
            `Discarded invalid param(s) "${invalidParams.join(
              '", "'
            )}" when navigating. See https://github.com/vuejs/router/blob/main/packages/router/CHANGELOG.md#414-2022-08-22 for more details.`
          )
        }
      }

      name = matcher.record.name
      params = assign(
        // paramsFromLocation is a new object
        paramsFromLocation(
          currentLocation.params,
          // only keep params that exist in the resolved location
          // TODO: only keep optional params coming from a parent record
          matcher.keys.filter(k => !k.optional).map(k => k.name)
        ),
        // discard any existing params in the current location that do not exist here
        // #1497 this ensures better active/exact matching
        location.params &&
        paramsFromLocation(
          location.params,
          matcher.keys.map(k => k.name)
        )
      )
      // throws if cannot be stringified
      path = matcher.stringify(params)
    } else if ('path' in location) {
      // no need to resolve the path with the matcher as it was provided
      // this also allows the user to control the encoding
      path = location.path

      if (__DEV__ && !path.startsWith('/')) {
        warn(
          `The Matcher cannot resolve relative paths but received "${path}". Unless you directly called \`matcher.resolve("${path}")\`, this is probably a bug in vue-router. Please open an issue at https://new-issue.vuejs.org/?repo=vuejs/router.`
        )
      }
      // 通过每个matcher的正则匹配对应的记录
      matcher = matchers.find(m => m.re.test(path))
      // matcher should have a value after the loop

      if (matcher) {
        // we know the matcher works because we tested the regexp
        params = matcher.parse(path)!
        name = matcher.record.name
      }
      // location is a relative path
    } else {
      // match by name or path of current route
      matcher = currentLocation.name
        ? matcherMap.get(currentLocation.name)
        : matchers.find(m => m.re.test(currentLocation.path))
      if (!matcher)
        throw createRouterError<MatcherError>(ErrorTypes.MATCHER_NOT_FOUND, {
          location,
          currentLocation,
        })
      name = matcher.record.name
      // since we are navigating to the same location, we don't need to pick the
      // params like when `name` is provided
      params = assign({}, currentLocation.params, location.params)
      path = matcher.stringify(params)
    }

    // 根据当前路由匹配结果，获取该路由的所有上层链路，根据parent属性一路向上查找
    const matched: MatcherLocation['matched'] = []
    let parentMatcher: RouteRecordMatcher | undefined = matcher
    while (parentMatcher) {
      // 父路由在数组开头
      matched.unshift(parentMatcher.record)
      parentMatcher = parentMatcher.parent
    }

    return {
      name,
      path,
      params,
      matched,
      // 合并链路上的所有meta
      meta: mergeMetaFields(matched),
    }
  }

  // add initial routes
  routes.forEach(route => addRoute(route))

  return { addRoute, resolve, removeRoute, getRoutes, getRecordMatcher }
}

function paramsFromLocation(
  params: MatcherLocation['params'],
  keys: string[]
): MatcherLocation['params'] {
  const newParams = {} as MatcherLocation['params']

  for (const key of keys) {
    if (key in params) newParams[key] = params[key]
  }

  return newParams
}

/**
 * Normalizes a RouteRecordRaw. Creates a copy
 *
 * @param record
 * @returns the normalized version
 */
export function normalizeRouteRecord(
  record: RouteRecordRaw
): RouteRecordNormalized {
  return {
    path: record.path,
    redirect: record.redirect,
    name: record.name,
    meta: record.meta || {},
    aliasOf: undefined,
    beforeEnter: record.beforeEnter,
    props: normalizeRecordProps(record),
    children: record.children || [],
    instances: {},
    leaveGuards: new Set(), // setup中使用的守卫
    updateGuards: new Set(),// setup中使用的守卫
    enterCallbacks: {},
    components:
      'components' in record
        ? record.components || null
        : record.component && { default: record.component },
  }
}

/**
 * Normalize the optional `props` in a record to always be an object similar to
 * components. Also accept a boolean for components.
 * @param record
 */
function normalizeRecordProps(
  record: RouteRecordRaw
): Record<string, _RouteRecordProps> {
  const propsObject = {} as Record<string, _RouteRecordProps>
  // props does not exist on redirect records, but we can set false directly
  const props = record.props || false
  if ('component' in record) {
    propsObject.default = props
  } else {
    // NOTE: we could also allow a function to be applied to every component.
    // Would need user feedback for use cases
    for (const name in record.components)
      propsObject[name] = typeof props === 'boolean' ? props : props[name]
  }

  return propsObject
}

/**
 * Checks if a record or any of its parent is an alias
 * @param record
 */
function isAliasRecord(record: RouteRecordMatcher | undefined): boolean {
  while (record) {
    if (record.record.aliasOf) return true
    record = record.parent
  }

  return false
}

/**
 * Merge meta fields of an array of records
 *
 * @param matched - array of matched records
 */
function mergeMetaFields(matched: MatcherLocation['matched']) {
  return matched.reduce(
    (meta, record) => assign(meta, record.meta),
    {} as MatcherLocation['meta']
  )
}
// 合并defaults中的key
function mergeOptions<T extends object>(
  defaults: T,
  partialOptions: Partial<T>
): T {
  const options = {} as T
  for (const key in defaults) {
    options[key] = key in partialOptions ? partialOptions[key]! : defaults[key]
  }

  return options
}

type ParamKey = RouteRecordMatcher['keys'][number]

function isSameParam(a: ParamKey, b: ParamKey): boolean {
  return (
    a.name === b.name &&
    a.optional === b.optional &&
    a.repeatable === b.repeatable
  )
}

/**
 * Check if a path and its alias have the same required params
 *
 * @param a - original record
 * @param b - alias record
 */
function checkSameParams(a: RouteRecordMatcher, b: RouteRecordMatcher) {
  for (const key of a.keys) {
    if (!key.optional && !b.keys.find(isSameParam.bind(null, key)))
      return warn(
        `Alias "${b.record.path}" and the original record: "${a.record.path}" must have the exact same param named "${key.name}"`
      )
  }
  for (const key of b.keys) {
    if (!key.optional && !a.keys.find(isSameParam.bind(null, key)))
      return warn(
        `Alias "${b.record.path}" and the original record: "${a.record.path}" must have the exact same param named "${key.name}"`
      )
  }
}

/**
 * A route with a name and a child with an empty path without a name should warn when adding the route
 *
 * @param mainNormalizedRecord - RouteRecordNormalized
 * @param parent - RouteRecordMatcher
 */
function checkChildMissingNameWithEmptyPath(
  mainNormalizedRecord: RouteRecordNormalized,
  parent?: RouteRecordMatcher
) {
  if (
    parent &&
    parent.record.name &&
    !mainNormalizedRecord.name &&
    !mainNormalizedRecord.path
  ) {
    warn(
      `The route named "${String(
        parent.record.name
      )}" has a child without a name and an empty path. Using that name won't render the empty path child so you probably want to move the name to the child instead. If this is intentional, add a name to the child route to remove the warning.`
    )
  }
}

function checkMissingParamsInAbsolutePath(
  record: RouteRecordMatcher,
  parent: RouteRecordMatcher
) {
  for (const key of parent.keys) {
    if (!record.keys.find(isSameParam.bind(null, key)))
      return warn(
        `Absolute path "${record.record.path}" must have the exact same param named "${key.name}" as its parent "${parent.record.path}".`
      )
  }
}

function isRecordChildOf(
  record: RouteRecordMatcher,
  parent: RouteRecordMatcher
): boolean {
  return parent.children.some(
    child => child === record || isRecordChildOf(record, child)
  )
}

export type { PathParserOptions, _PathParserOptions }
