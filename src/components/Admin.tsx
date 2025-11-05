import { useState, useEffect, useRef } from 'react'
import './Admin.css'

interface Image {
  id: string
  filename: string
  originalName: string
  path: string
  uploadedAt: string
  active: boolean
}

function Admin() {
  const [images, setImages] = useState<Image[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetchImages()
  }, [])

  const fetchImages = async () => {
    try {
      const response = await fetch('/api/images')
      if (!response.ok) throw new Error('Failed to fetch images')
      const data = await response.json()
      setImages(data)
      setLoading(false)
    } catch (err) {
      console.error('Error fetching images:', err)
      setLoading(false)
    }
  }

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    setUploading(true)

    try {
      for (let i = 0; i < files.length; i++) {
        const formData = new FormData()
        formData.append('image', files[i])

        const response = await fetch('/api/images/upload', {
          method: 'POST',
          body: formData,
        })

        if (!response.ok) throw new Error('Upload failed')
      }

      await fetchImages()
    } catch (err) {
      console.error('Error uploading images:', err)
      alert('Failed to upload some images')
    } finally {
      setUploading(false)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  const toggleActive = async (id: string) => {
    try {
      const response = await fetch(`/api/images/${id}/toggle`, {
        method: 'PATCH',
      })

      if (!response.ok) throw new Error('Toggle failed')
      await fetchImages()
    } catch (err) {
      console.error('Error toggling image:', err)
    }
  }

  const deleteImage = async (id: string) => {
    if (!confirm('Are you sure you want to delete this image?')) return

    try {
      const response = await fetch(`/api/images/${id}`, {
        method: 'DELETE',
      })

      if (!response.ok) throw new Error('Delete failed')
      await fetchImages()
    } catch (err) {
      console.error('Error deleting image:', err)
    }
  }

  if (loading) {
    return <div className="admin-container">Loading...</div>
  }

  return (
    <div className="admin-container">
      <div className="admin-header">
        <h2>Photo Gallery</h2>
        <label className="upload-btn">
          {uploading ? 'Uploading...' : '+ Upload Photos'}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={handleUpload}
            disabled={uploading}
            style={{ display: 'none' }}
          />
        </label>
      </div>

      {images.length === 0 ? (
        <div className="empty-state">
          <p>No photos yet</p>
          <p className="empty-hint">Click "Upload Photos" to get started</p>
        </div>
      ) : (
        <div className="images-grid">
          {images.map((image) => (
            <div key={image.id} className={`image-card ${!image.active ? 'inactive' : ''}`}>
              <div className="image-wrapper">
                <img src={image.path} alt={image.originalName} />
                {!image.active && <div className="inactive-overlay">Hidden</div>}
              </div>
              <div className="image-info">
                <p className="image-name" title={image.originalName}>
                  {image.originalName}
                </p>
                <div className="image-actions">
                  <button
                    className={`action-btn ${image.active ? 'hide-btn' : 'show-btn'}`}
                    onClick={() => toggleActive(image.id)}
                  >
                    {image.active ? '👁️ Hide' : '👁️‍🗨️ Show'}
                  </button>
                  <button
                    className="action-btn delete-btn"
                    onClick={() => deleteImage(image.id)}
                  >
                    🗑️ Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default Admin

