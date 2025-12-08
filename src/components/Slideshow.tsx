import { useState, useEffect, useRef } from 'react'
import { useWebSocket } from '../context/WebSocketContext'
import './Slideshow.css'

interface SlideshowProps {
  onShowNav?: () => void
}

function Slideshow({ onShowNav }: SlideshowProps) {
  const { activeImages, slideshowState, connected, setCurrentImage } = useWebSocket()
  const [currentIndex, setCurrentIndex] = useState(0)
  const [currentImageId, setCurrentImageId] = useState<string | null>(null)
  const lastSyncedImageIdRef = useRef<string | null>(null)

  const { duration, currentImageId: serverCurrentImageId } = slideshowState

  // Sync with server's current image when it changes (e.g., from admin "Show Now")
  useEffect(() => {
    if (serverCurrentImageId && serverCurrentImageId !== lastSyncedImageIdRef.current) {
      const idx = activeImages.findIndex(img => img.id === serverCurrentImageId)
      if (idx !== -1) {
        setCurrentIndex(idx)
        setCurrentImageId(serverCurrentImageId)
        lastSyncedImageIdRef.current = serverCurrentImageId
      }
    }
  }, [serverCurrentImageId, activeImages])

  // Handle image list changes
  useEffect(() => {
    if (activeImages.length === 0) {
      setCurrentImageId(null)
      setCurrentIndex(0)
      return
    }

    // If current image was removed, adjust index
    if (currentImageId) {
      const idx = activeImages.findIndex(img => img.id === currentImageId)
      if (idx === -1) {
        // Current image no longer in list, pick safe index
        const safeIndex = Math.min(currentIndex, activeImages.length - 1)
        setCurrentIndex(safeIndex)
        setCurrentImageId(activeImages[safeIndex].id)
      } else if (idx !== currentIndex) {
        // Image moved position
        setCurrentIndex(idx)
      }
    } else {
      // No current image, set to first
      setCurrentIndex(0)
      setCurrentImageId(activeImages[0].id)
    }
  }, [activeImages, currentImageId, currentIndex])

  // Auto-advance slideshow
  useEffect(() => {
    if (activeImages.length <= 1) return

    const interval = setInterval(() => {
      setCurrentIndex((prev) => {
        const nextIndex = (prev + 1) % activeImages.length
        const nextImageId = activeImages[nextIndex]?.id || null
        setCurrentImageId(nextImageId)
        // Notify server of current image change
        if (nextImageId) {
          setCurrentImage(nextImageId)
        }
        return nextIndex
      })
    }, duration)

    return () => clearInterval(interval)
  }, [activeImages, duration, setCurrentImage])

  // Update current image ID when index changes manually
  useEffect(() => {
    if (activeImages.length > 0) {
      const safeIndex = Math.min(currentIndex, activeImages.length - 1)
      if (safeIndex !== currentIndex) {
        setCurrentIndex(safeIndex)
      }
      
      const image = activeImages[safeIndex]
      if (image && image.id !== currentImageId) {
        setCurrentImageId(image.id)
        setCurrentImage(image.id)
      }
    }
  }, [currentIndex, activeImages, currentImageId, setCurrentImage])

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (activeImages.length === 0) return
      
      switch(e.key) {
        case 'ArrowLeft':
          if (activeImages.length > 1) {
            setCurrentIndex((prev) => (prev - 1 + activeImages.length) % activeImages.length)
          }
          break
        case 'ArrowRight':
          if (activeImages.length > 1) {
            setCurrentIndex((prev) => (prev + 1) % activeImages.length)
          }
          break
        case 'Escape':
          if (onShowNav) onShowNav()
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeImages.length, onShowNav])

  if (!connected) {
    return (
      <div className="slideshow-container">
        <div className="slideshow-message">Connecting...</div>
      </div>
    )
  }

  if (activeImages.length === 0) {
    return (
      <div className="slideshow-container">
        <div className="slideshow-message">
          No active images to display
          <p className="slideshow-hint">
            Switch to "Manage Photos" to upload images
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="slideshow-container">
      {activeImages.map((image, index) => (
        <div
          key={image.id}
          className={`slideshow-image ${index === currentIndex ? 'active' : ''}`}
        >
          <img src={image.path} alt={image.originalName} />
        </div>
      ))}
    </div>
  )
}

export default Slideshow
