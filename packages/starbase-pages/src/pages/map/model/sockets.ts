// Socket id helpers shared by the Process map's pure model (see buildGraph.ts for the id scheme).

/** The node a socket id (`<nodeId>:in:<i>`, `<nodeId>:out:<i>`, `…:b`) belongs to. */
export const nodeOfSocket = (socket: string) => socket.replace(/:(?:in|out):[^:]+$/, '');

/** True for the shared bundle sockets of a folded container or card. */
export const isBundleSocket = (socket: string) => socket.endsWith(':b');
