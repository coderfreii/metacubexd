import { differenceWith, isNumber, unionWith } from 'lodash'
import { createEffect, createSignal, untrack } from 'solid-js'
import { CONNECTIONS_TABLE_MAX_CLOSED_ROWS } from '~/constants'
import { Connection, ConnectionRawMessage } from '~/types'

export type WsMsg = {
  connections?: ConnectionRawMessage[]
  uploadTotal: number
  downloadTotal: number
} | null

// we make connections global, so we can keep track of connections when user in proxy page
// when user selects proxy and close some connections they can back and check connections
// they closed
export const [allConnections, setAllConnections] = createSignal<Connection[]>(
  [],
)
export const [latestConnectionMsg, setLatestConnectionMsg] =
  createSignal<WsMsg>(null)

export const useConnections = () => {
  const [closedConnections, setClosedConnections] = createSignal<Connection[]>(
    [],
  )
  const [activeConnections, setActiveConnections] = createSignal<Connection[]>(
    [],
  )
  const [virtualConnections, setVirtualConnections] = createSignal<
    Map<string, Connection>
  >(new Map<string, Connection>())

  const [paused, setPaused] = createSignal(false)

  createEffect(() => {
    const rawConns = latestConnectionMsg()?.connections

    if (!rawConns) {
      return
    }

    untrack(() => {
      const activeConns = restructRawMsgToConnection(
        rawConns,
        activeConnections(),
      )

      mergeAllConnections(activeConnections())

      const virtualConns = reStructAllActiveConnectionsToVirtualConnection(
        virtualConnections(),
        activeConns,
      )

      if (!paused()) {
        const closedConns = diffClosedConnections(activeConns, allConnections())

        setActiveConnections(activeConns)
        setClosedConnections(
          closedConns.slice(-CONNECTIONS_TABLE_MAX_CLOSED_ROWS),
        )
        setVirtualConnections(virtualConns)
      }

      setAllConnections((allConnections) =>
        allConnections.slice(
          -(activeConns.length + CONNECTIONS_TABLE_MAX_CLOSED_ROWS),
        ),
      )
    })
  })

  return {
    closedConnections,
    activeConnections,
    paused,
    setPaused,
    virtualConnections,
  }
}

export const reStructAllActiveConnectionsToVirtualConnection = (
  pre: Map<string, Connection>,
  allActiveConnections: Connection[],
): Map<string, Connection> => {
  const currentMap = new Map<string, Connection>()

  allActiveConnections.forEach((connection) => {
    let current
    let prevConn

    if (connection.chains.includes('Proxy')) {
      current = currentMap.get('Proxy')
      prevConn = pre.get('Proxy')

      if (
        !current ||
        !isNumber(current.download) ||
        !isNumber(current.upload)
      ) {
        current = {
          ...connection,
          upload: prevConn?.upload || 0,
          download: prevConn?.download || 0,
          preserve: 'Proxy',
        }
        currentMap.set('Proxy', current)
      }
    } else {
      current = currentMap.get('DIRECT')
      prevConn = pre.get('DIRECT')

      if (
        !current ||
        !isNumber(current.download) ||
        !isNumber(current.upload)
      ) {
        current = {
          ...connection,
          upload: prevConn?.upload || 0,
          download: prevConn?.download || 0,
          preserve: 'DIRECT',
        }
        currentMap.set('DIRECT', current)
      }
    }

    if (prevConn && current) {
      current.upload += connection.uploadSpeed
      current.download += connection.downloadSpeed

      current.downloadSpeed += connection.downloadSpeed
      current.uploadSpeed += connection.uploadSpeed
    } else if (current) {
      current.upload += connection.upload
      current.download += connection.download

      current.downloadSpeed += connection.downloadSpeed
      current.uploadSpeed += connection.uploadSpeed
    }
  })

  return currentMap
}

export const restructRawMsgToConnection = (
  connections: ConnectionRawMessage[],
  prevActiveConnections: Connection[],
): Connection[] => {
  const prevMap = new Map<string, Connection>()
  prevActiveConnections.forEach((prev) => prevMap.set(prev.id, prev))

  return connections.map((connection) => {
    const prevConn = prevMap.get(connection.id)

    if (
      !prevConn ||
      !isNumber(prevConn.download) ||
      !isNumber(prevConn.upload)
    ) {
      return { ...connection, downloadSpeed: 0, uploadSpeed: 0 }
    }

    return {
      ...connection,
      downloadSpeed: connection.download - prevConn.download,
      uploadSpeed: connection.upload - prevConn.upload,
    }
  })
}

export const mergeAllConnections = (activeConns: Connection[]) => {
  setAllConnections((allConnections) =>
    unionWith(allConnections, activeConns, (a, b) => a.id === b.id),
  )
}

const diffClosedConnections = (
  activeConns: Connection[],
  allConns: Connection[],
) => differenceWith(allConns, activeConns, (a, b) => a.id === b.id)
