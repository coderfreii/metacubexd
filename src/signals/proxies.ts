import { batch, createSignal, untrack } from 'solid-js'
import {
  closeSingleConnectionAPI,
  fetchProxiesAPI,
  fetchProxyProvidersAPI,
  proxyGroupLatencyTestAPI,
  proxyLatencyTestAPI,
  proxyProviderHealthCheckAPI,
  selectProxyInGroupAPI,
  updateProxyProviderAPI,
} from '~/apis'
import { useStringBooleanMap } from '~/helpers'
import {
  autoCloseConns,
  latencyQualityMap,
  latencyTestTimeoutDuration,
  latestConnectionMsg,
  restructRawMsgToConnection,
  urlForIPv6SupportTest,
  urlForLatencyTest,
} from '~/signals'
import type { IPV6_Latency, Proxy, ProxyNode, ProxyProvider } from '~/types'

type ProxyInfo = {
  name: string
  udp: boolean
  now: string
  xudp: boolean
  type: string
  provider: string
}

export type ProxyWithProvider = Proxy & { provider?: string }
export type ProxyNodeWithProvider = ProxyNode & { provider?: string }

const { map: collapsedMap, set: setCollapsedMap } = useStringBooleanMap()
const {
  map: proxyLatencyTestingMap,
  setWithCallback: setProxyLatencyTestingMap,
} = useStringBooleanMap()
const {
  map: proxyGroupLatencyTestingMap,
  setWithCallback: setProxyGroupLatencyTestingMap,
} = useStringBooleanMap()
const {
  map: proxyProviderLatencyTestingMap,
  setWithCallback: setProxyProviderLatencyTestingMap,
} = useStringBooleanMap()
const { map: updatingMap, setWithCallback: setUpdatingMap } =
  useStringBooleanMap()
const [isAllProviderUpdating, setIsAllProviderUpdating] = createSignal(false)

// these signals should be global state
const [proxies, setProxies] = createSignal<ProxyWithProvider[]>([])
const [proxyProviders, setProxyProviders] = createSignal<
  (ProxyProvider & { proxies: ProxyNodeWithProvider[] })[]
>([])

const [latencyMap, setLatencyMap] = createSignal<Record<string, number>>({})
const [proxyIPv6SupportMap, setProxyIPv6SupportMap] = createSignal<
  Record<string, IPV6_Latency>
>({})
const [proxyNodeMap, setProxyNodeMap] = createSignal<Record<string, ProxyInfo>>(
  {},
)

const setProxiesInfo = (
  proxies: (ProxyWithProvider | ProxyNodeWithProvider)[],
) => {
  const newProxyNodeMap = { ...proxyNodeMap() }
  const newLatencyMap = { ...latencyMap() }
  const newProxyIPv6SupportMap = { ...proxyIPv6SupportMap() }

  const lastDelay = (
    proxy: Pick<Proxy, 'extra' | 'history'>,
    url: string,
    fallbackDefault = true,
  ) => {
    const extra = proxy.extra?.[url] as Proxy['history'] | undefined

    if (Array.isArray(extra)) {
      const delay = extra.at(-1)?.delay

      if (delay || !fallbackDefault) {
        return delay
      }
    }

    const len = Object.entries(proxy.extra).length

    if (len <= 1) {
      // due to extra ipv6 latency test the index of -1 is ipv6 latency
      return proxy.history?.at(-2)?.delay
    }
  }

  proxies.forEach((proxy) => {
    const { udp, xudp, type, now, name, provider = '' } = proxy
    newProxyNodeMap[proxy.name] = { udp, xudp, type, now, name, provider }

    const latency =
      lastDelay(proxy, urlForLatencyTest()) || latencyQualityMap().NOT_CONNECTED
    newLatencyMap[proxy.name] = latency

    const proxyIPv6Latency =
      lastDelay(proxy, urlForIPv6SupportTest(), false) ||
      latencyQualityMap().NOT_CONNECTED
    const proxyIPv6Support = (proxyIPv6Latency ?? 0) > 0
    newProxyIPv6SupportMap[proxy.name] = {
      support: proxyIPv6Support,
      latency: proxyIPv6Latency,
    }
  })

  batch(() => {
    setProxyNodeMap(newProxyNodeMap)
    setLatencyMap(newLatencyMap)
    setProxyIPv6SupportMap(newProxyIPv6SupportMap)
  })
}

export const useProxies = () => {
  const fetchProxies = async () => {
    const [{ providers }, { proxies }] = await Promise.all([
      fetchProxyProvidersAPI(),
      fetchProxiesAPI(),
    ])

    const sortIndex = [...(proxies['GLOBAL'].all ?? []), 'GLOBAL']
    const sortedProxies = Object.values(proxies)
      .filter((proxy) => proxy.all?.length)
      .sort(
        (prev, next) =>
          sortIndex.indexOf(prev.name) - sortIndex.indexOf(next.name),
      )
    const sortedProviders = Object.values(providers).filter(
      (provider) =>
        provider.name !== 'default' && provider.vehicleType !== 'Compatible',
    )

    const allProxies = [
      ...Object.values(proxies),
      ...sortedProviders.flatMap((provider) =>
        provider.proxies
          .filter((proxy) => !(proxy.name in proxies))
          .map((proxy) => ({
            ...proxy,
            provider: provider.name,
          })),
      ),
    ]

    batch(() => {
      setProxies(sortedProxies)
      setProxyProviders(sortedProviders)
      setProxiesInfo(allProxies)
    })
  }

  const selectProxyInGroup = async (proxy: Proxy, proxyName: string) => {
    await selectProxyInGroupAPI(proxy.name, proxyName)
    await fetchProxies()

    if (autoCloseConns()) {
      // we don't use activeConns from useConnection here for better performance,
      // and we use empty array to restruct msg because they are closed, they won't have speed anyway
      untrack(() => {
        const activeConns = restructRawMsgToConnection(
          latestConnectionMsg()?.connections ?? [],
          [],
        )

        if (activeConns.length > 0) {
          activeConns.forEach(({ id, chains }) => {
            if (chains.includes(proxy.name)) {
              closeSingleConnectionAPI(id)
            }
          })
        }
      })
    }
  }

  const proxyIPv6SupportTest = async (proxyName: string, provider: string) => {
    const urlForTest = urlForIPv6SupportTest()

    if (!urlForTest || urlForTest.length === 0) {
      setProxyIPv6SupportMap({})

      return
    }

    let support = false
    let latency = 0
    try {
      const { delay } = await proxyLatencyTestAPI(
        proxyName,
        provider,
        urlForTest,
        latencyTestTimeoutDuration(),
      )
      latency = delay
      support = delay > 0
    } catch {
      support = false
    }
    setProxyIPv6SupportMap((supportMap) => ({
      ...supportMap,
      [proxyName]: {
        support,
        latency,
      },
    }))
  }
  const proxyGroupIPv6SupportTest = async (proxyGroupName: string) => {
    const urlForTest = urlForIPv6SupportTest()

    if (!urlForTest || urlForTest.length === 0) {
      setProxyIPv6SupportMap({})

      return
    }

    const newLatencyMap = await proxyGroupLatencyTestAPI(
      proxyGroupName,
      urlForTest,
      latencyTestTimeoutDuration(),
    )
    const newSupportMap = Object.fromEntries(
      Object.entries(newLatencyMap).map(([k, v]) => [
        k,
        { support: v > 0, latency: v },
      ]),
    )
    setProxyIPv6SupportMap((supportMap) => ({
      ...supportMap,
      ...newSupportMap,
    }))
  }

  const proxyLatencyTest = async (proxyName: string, provider: string) => {
    await setProxyLatencyTestingMap(proxyName, async () => {
      const { delay } = await proxyLatencyTestAPI(
        proxyName,
        provider,
        urlForLatencyTest(),
        latencyTestTimeoutDuration(),
      )

      setLatencyMap((latencyMap) => ({
        ...latencyMap,
        [proxyName]: delay,
      }))
    })
    await proxyIPv6SupportTest(proxyName, provider)
  }

  const proxyGroupLatencyTest = async (proxyGroupName: string) => {
    await setProxyGroupLatencyTestingMap(proxyGroupName, async () => {
      await proxyGroupLatencyTestAPI(
        proxyGroupName,
        'https://google.com', //anything different from current using testing url should be fine.
        //all the reason to do this is that the meta core just doesn't record the very first group check url into the "extra" filed
        //no matter how many times,and testing single one proxy does.
        //in the meantime the "history" filed records everything had been tested which is kind messy to use.
        //the whole situation we have that make it difficult to distinguish from those cases, so we first test one url we don't need, thus no first at all.problem solved!
        //after all it should be the problem for the core to solve which didn't perfectly support test more than one url feature. here is just a hack way.
        latencyTestTimeoutDuration(),
      )

      const newLatencyMap = await proxyGroupLatencyTestAPI(
        proxyGroupName,
        urlForLatencyTest(),
        latencyTestTimeoutDuration(),
      )

      setLatencyMap((latencyMap) => ({
        ...latencyMap,
        ...newLatencyMap,
      }))
      // no need to call fetchProxies here, and it causes bug because the extra ipv6 latency test after
      // await fetchProxies()
    })
    await proxyGroupIPv6SupportTest(proxyGroupName)
  }

  const updateProviderByProviderName = (providerName: string) =>
    setUpdatingMap(providerName, async () => {
      try {
        await updateProxyProviderAPI(providerName)
      } catch {}
      await fetchProxies()
    })

  const updateAllProvider = async () => {
    setIsAllProviderUpdating(true)
    try {
      await Promise.allSettled(
        proxyProviders().map((provider) =>
          updateProxyProviderAPI(provider.name),
        ),
      )
      await fetchProxies()
    } finally {
      setIsAllProviderUpdating(false)
    }
  }

  const proxyProviderLatencyTest = (providerName: string) =>
    setProxyProviderLatencyTestingMap(providerName, async () => {
      await proxyProviderHealthCheckAPI(providerName)
      await fetchProxies()
    })

  return {
    collapsedMap,
    setCollapsedMap,
    proxyIPv6SupportMap,
    proxyLatencyTestingMap,
    proxyGroupLatencyTestingMap,
    proxyProviderLatencyTestingMap,
    updatingMap,
    isAllProviderUpdating,
    proxies,
    proxyProviders,
    proxyLatencyTest,
    proxyGroupLatencyTest,
    latencyMap,
    proxyNodeMap,
    fetchProxies,
    selectProxyInGroup,
    updateProviderByProviderName,
    updateAllProvider,
    proxyProviderLatencyTest,
  }
}
