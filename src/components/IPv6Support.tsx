import { Show, createMemo } from 'solid-js'
import { useProxies } from '~/signals'

export const IPv6Support = (props: { name?: string }) => {
  const { proxyIPv6SupportMap } = useProxies()
  const support = createMemo(
    () => proxyIPv6SupportMap()[props.name!].support === true,
  )

  return (
    <Show when={support()}>
      <div
        class="tooltip"
        data-tip={proxyIPv6SupportMap()[props.name!].latency}
      >
        <span class="badge badge-sm p-px">
          <span class="scale-75">IPv6</span>
        </span>
      </div>
    </Show>
  )
}
