import { createContext, useContext, useEffect, useRef, useState, useCallback, ReactNode } from 'react'

export interface Image {
  id: string
  filename: string
  originalName: string
  path: string
  uploadedAt: string
  active: boolean
  collectionIds: string[]
}

export interface Collection {
  id: string
  name: string
  description?: string
  createdAt: string
}

export interface SlideshowState {
  currentImageId: string | null
  duration: number
  activeCollectionId: string | null
}

// Events received from server
type ServerEvent = 
  | { type: 'connected'; state: SlideshowState; images: Image[]; collections: Collection[] }
  | { type: 'images_updated'; images: Image[] }
  | { type: 'collections_updated'; collections: Collection[] }
  | { type: 'state_updated'; state: SlideshowState }

// Messages sent to server
export type ClientMessage = 
  | { type: 'set_current_image'; imageId: string | null }
  | { type: 'set_duration'; duration: number }
  | { type: 'set_active_collection'; collectionId: string | null }

interface WebSocketContextType {
  // Connection state
  connected: boolean
  
  // Data
  images: Image[]
  activeImages: Image[]
  collections: Collection[]
  slideshowState: SlideshowState
  
  // Actions (send via WebSocket)
  setCurrentImage: (imageId: string | null) => void
  setDuration: (duration: number) => void
  setActiveCollection: (collectionId: string | null) => void
  
  // WebSocket ref for components that need direct access
  send: (message: ClientMessage) => void
}

const WebSocketContext = createContext<WebSocketContextType | null>(null)

export function useWebSocket() {
  const context = useContext(WebSocketContext)
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider')
  }
  return context
}

interface WebSocketProviderProps {
  children: ReactNode
}

export function WebSocketProvider({ children }: WebSocketProviderProps) {
  const [connected, setConnected] = useState(false)
  const [images, setImages] = useState<Image[]>([])
  const [collections, setCollections] = useState<Collection[]>([])
  const [slideshowState, setSlideshowState] = useState<SlideshowState>({
    currentImageId: null,
    duration: 120000,
    activeCollectionId: null,
  })
  
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Compute active images based on current slideshow state
  const activeImages = images.filter(img => {
    if (!img.active) return false
    if (slideshowState.activeCollectionId) {
      return img.collectionIds?.includes(slideshowState.activeCollectionId)
    }
    return true
  })

  // Send message to server
  const send = useCallback((message: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message))
    } else {
      console.warn('WebSocket not connected, cannot send message')
    }
  }, [])

  // Action helpers
  const setCurrentImage = useCallback((imageId: string | null) => {
    send({ type: 'set_current_image', imageId })
  }, [send])

  const setDuration = useCallback((duration: number) => {
    send({ type: 'set_duration', duration })
  }, [send])

  const setActiveCollection = useCallback((collectionId: string | null) => {
    send({ type: 'set_active_collection', collectionId })
  }, [send])

  // Handle incoming messages
  const handleMessage = useCallback((event: MessageEvent) => {
    try {
      const data: ServerEvent = JSON.parse(event.data)
      
      switch (data.type) {
        case 'connected':
          setImages(data.images)
          setCollections(data.collections)
          setSlideshowState(data.state)
          break
          
        case 'images_updated':
          setImages(data.images)
          break
          
        case 'collections_updated':
          setCollections(data.collections)
          break
          
        case 'state_updated':
          setSlideshowState(data.state)
          break
      }
    } catch (err) {
      console.error('Failed to parse WebSocket message:', err)
    }
  }, [])

  // Connect to WebSocket
  const connect = useCallback(() => {
    // Clear any existing reconnect timeout
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }

    // Close existing connection
    if (wsRef.current) {
      wsRef.current.close()
    }

    // Determine WebSocket URL based on current location
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/ws`
    
    console.log('Connecting to WebSocket:', wsUrl)
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      console.log('WebSocket connected')
      setConnected(true)
    }

    ws.onmessage = handleMessage

    ws.onclose = () => {
      console.log('WebSocket disconnected, reconnecting in 3 seconds...')
      setConnected(false)
      reconnectTimeoutRef.current = setTimeout(connect, 3000)
    }

    ws.onerror = (error) => {
      console.error('WebSocket error:', error)
    }
  }, [handleMessage])

  // Initialize connection
  useEffect(() => {
    connect()
    
    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
      }
      if (wsRef.current) {
        wsRef.current.close()
      }
    }
  }, [connect])

  const value: WebSocketContextType = {
    connected,
    images,
    activeImages,
    collections,
    slideshowState,
    setCurrentImage,
    setDuration,
    setActiveCollection,
    send,
  }

  return (
    <WebSocketContext.Provider value={value}>
      {children}
    </WebSocketContext.Provider>
  )
}

