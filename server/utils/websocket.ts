import { WebSocket, WebSocketServer } from 'ws';
import type { Server } from 'http';
import { 
  getImages, 
  getSlideshowState, 
  getCollections,
  setCurrentImage,
  setSlideshowDuration,
  setActiveCollection,
  ImageMetadata,
  Collection
} from './imageStore';

// Events sent to clients
export type ServerEvent = 
  | { type: 'connected'; state: ReturnType<typeof getSlideshowState>; images: ImageMetadata[]; collections: Collection[] }
  | { type: 'images_updated'; images: ImageMetadata[] }
  | { type: 'collections_updated'; collections: Collection[] }
  | { type: 'state_updated'; state: ReturnType<typeof getSlideshowState> };

// Messages received from clients
type ClientMessage = 
  | { type: 'set_current_image'; imageId: string | null }
  | { type: 'set_duration'; duration: number }
  | { type: 'set_active_collection'; collectionId: string | null };

let wss: WebSocketServer | null = null;

/**
 * Let an additional http server (e.g. the port-80 listener) accept WebSocket
 * upgrades on /ws, served by the same WebSocketServer.
 */
export function attachWebSocketUpgrade(server: Server): void {
  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url ?? '', 'http://localhost').pathname;
    } catch {
      /* fall through to reject */
    }
    if (!wss || pathname !== '/ws') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const target = wss;
    target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req));
  });
}

export function initWebSocketServer(server: Server): WebSocketServer {
  wss = new WebSocketServer({ noServer: true });
  attachWebSocketUpgrade(server);

  wss.on('connection', (ws: WebSocket) => {
    console.log('WebSocket client connected');

    // Send initial state to newly connected client
    const state = getSlideshowState();
    const images = getImages();
    const collections = getCollections();
    
    const connectEvent: ServerEvent = {
      type: 'connected',
      state,
      images,
      collections,
    };
    
    ws.send(JSON.stringify(connectEvent));

    // Handle messages from client
    ws.on('message', (data: Buffer) => {
      try {
        const message: ClientMessage = JSON.parse(data.toString());
        
        switch (message.type) {
          case 'set_current_image':
            setCurrentImage(message.imageId);
            broadcastStateUpdated();
            break;
            
          case 'set_duration':
            if (typeof message.duration === 'number' && message.duration >= 1000) {
              setSlideshowDuration(message.duration);
              broadcastStateUpdated();
            }
            break;
            
          case 'set_active_collection':
            setActiveCollection(message.collectionId);
            broadcastStateUpdated();
            broadcastImagesUpdated(); // Active images may change
            break;
        }
      } catch (err) {
        console.error('Failed to parse client message:', err);
      }
    });

    ws.on('close', () => {
      console.log('WebSocket client disconnected');
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });
  });

  console.log('WebSocket server initialized on /ws');
  return wss;
}

// Broadcast to all connected clients
export function broadcast(event: ServerEvent): void {
  if (!wss) {
    console.warn('WebSocket server not initialized');
    return;
  }

  const message = JSON.stringify(event);
  
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// Helper functions to broadcast specific events
export function broadcastImagesUpdated(): void {
  const images = getImages();
  broadcast({ type: 'images_updated', images });
}

export function broadcastCollectionsUpdated(): void {
  const collections = getCollections();
  broadcast({ type: 'collections_updated', collections });
}

export function broadcastStateUpdated(): void {
  const state = getSlideshowState();
  broadcast({ type: 'state_updated', state });
}
