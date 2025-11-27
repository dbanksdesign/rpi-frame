import { useState, useEffect } from 'react'
import {
  Container,
  Title,
  Button,
  FileButton,
  SimpleGrid,
  Card,
  Image as MantineImage,
  Text,
  Group,
  Badge,
  ActionIcon,
  Loader,
  Stack,
  Notification,
  Box,
  Paper,
  NumberInput,
  Divider,
  Select,
  Modal,
  TextInput,
  Textarea,
  MultiSelect,
  Chip,
} from '@mantine/core'
import { IconUpload, IconEye, IconEyeOff, IconTrash, IconPhoto, IconPlayerPlay, IconClock, IconPlus, IconFolder, IconFolderPlus, IconEdit } from '@tabler/icons-react'
import './Admin.css'

interface Image {
  id: string
  filename: string
  originalName: string
  path: string
  uploadedAt: string
  active: boolean
  collectionIds: string[]
}

interface Collection {
  id: string
  name: string
  description?: string
  createdAt: string
}

interface SlideshowState {
  currentImageId: string | null
  duration: number
  activeCollectionId: string | null
}

type TimeUnit = 'seconds' | 'minutes' | 'hours'

function Admin() {
  const [images, setImages] = useState<Image[]>([])
  const [collections, setCollections] = useState<Collection[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [notification, setNotification] = useState<string | null>(null)
  const [files, setFiles] = useState<File[]>([])
  const [currentImageId, setCurrentImageId] = useState<string | null>(null)
  const [durationValue, setDurationValue] = useState(2)
  const [durationUnit, setDurationUnit] = useState<TimeUnit>('minutes')
  const [durationSaving, setDurationSaving] = useState(false)
  const [activeCollectionId, setActiveCollectionId] = useState<string | null>(null)
  const [filterCollectionId, setFilterCollectionId] = useState<string | null>(null)
  const [createCollectionOpen, setCreateCollectionOpen] = useState(false)
  const [newCollectionName, setNewCollectionName] = useState('')
  const [newCollectionDescription, setNewCollectionDescription] = useState('')

  const showNotification = (message: string) => {
    setNotification(message)
    setTimeout(() => setNotification(null), 3000)
  }

  useEffect(() => {
    fetchImages()
    fetchCollections()
    fetchSlideshowState(true) // Load duration and collection on initial mount
    
    // Poll for current image updates only (not duration)
    const interval = setInterval(() => fetchSlideshowState(false), 10000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (files.length > 0) {
      handleUpload(files)
      setFiles([])
    }
  }, [files])

  const fetchImages = async () => {
    try {
      const response = await fetch('/api/images')
      if (!response.ok) throw new Error('Failed to fetch images')
      const data = await response.json()
      // Ensure collectionIds is initialized for backwards compatibility
      const imagesWithCollections = data.map((img: Image) => ({
        ...img,
        collectionIds: img.collectionIds || []
      }))
      setImages(imagesWithCollections)
      setLoading(false)
    } catch (err) {
      console.error('Error fetching images:', err)
      setLoading(false)
    }
  }

  const fetchCollections = async () => {
    try {
      const response = await fetch('/api/collections')
      if (!response.ok) throw new Error('Failed to fetch collections')
      const data = await response.json()
      setCollections(data)
    } catch (err) {
      console.error('Error fetching collections:', err)
    }
  }

  const convertMsToValueAndUnit = (ms: number): { value: number; unit: TimeUnit } => {
    // Try to find the best unit that results in a whole number
    const hours = ms / (1000 * 60 * 60)
    const minutes = ms / (1000 * 60)
    const seconds = ms / 1000

    if (hours >= 1 && hours === Math.floor(hours)) {
      return { value: hours, unit: 'hours' }
    } else if (minutes >= 1 && minutes === Math.floor(minutes)) {
      return { value: minutes, unit: 'minutes' }
    } else {
      return { value: seconds, unit: 'seconds' }
    }
  }

  const convertToMs = (value: number, unit: TimeUnit): number => {
    switch (unit) {
      case 'seconds':
        return value * 1000
      case 'minutes':
        return value * 1000 * 60
      case 'hours':
        return value * 1000 * 60 * 60
    }
  }

  const fetchSlideshowState = async (includeDuration = false) => {
    try {
      const response = await fetch('/api/slideshow/state')
      if (!response.ok) throw new Error('Failed to fetch slideshow state')
      const data: SlideshowState = await response.json()
      setCurrentImageId(data.currentImageId)
      setActiveCollectionId(data.activeCollectionId)
      
      // Only update duration on initial load or after successful save
      // to prevent overwriting user's edits while they're typing
      if (includeDuration) {
        const { value, unit } = convertMsToValueAndUnit(data.duration)
        setDurationValue(value)
        setDurationUnit(unit)
      }
    } catch (err) {
      console.error('Error fetching slideshow state:', err)
    }
  }

  const showImageNow = async (imageId: string) => {
    try {
      const response = await fetch('/api/slideshow/current', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ imageId }),
      })

      if (!response.ok) throw new Error('Failed to set current image')
      setCurrentImageId(imageId)
      showNotification('Image will display now on the frame!')
    } catch (err) {
      console.error('Error setting current image:', err)
      alert('Failed to set current image')
    }
  }

  const updateDuration = async () => {
    if (durationValue < 1) {
      alert('Duration must be at least 1')
      return
    }

    const durationMs = convertToMs(durationValue, durationUnit)
    
    if (durationMs < 1000) {
      alert('Duration must be at least 1 second')
      return
    }

    setDurationSaving(true)
    try {
      const response = await fetch('/api/slideshow/duration', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ duration: durationMs }),
      })

      if (!response.ok) throw new Error('Failed to update duration')
      showNotification('Duration updated! Changes will apply to the next photo.')
      
      // Refresh duration from server after successful save
      await fetchSlideshowState(true)
    } catch (err) {
      console.error('Error updating duration:', err)
      alert('Failed to update duration')
    } finally {
      setDurationSaving(false)
    }
  }

  const handleUpload = async (filesToUpload: File[]) => {
    if (!filesToUpload || filesToUpload.length === 0) return

    setUploading(true)

    try {
      for (let i = 0; i < filesToUpload.length; i++) {
        const formData = new FormData()
        formData.append('image', filesToUpload[i])

        const response = await fetch('/api/images/upload', {
          method: 'POST',
          body: formData,
        })

        if (!response.ok) throw new Error('Upload failed')
      }

      await fetchImages()
      showNotification('Photos uploaded! Slideshow will update automatically.')
    } catch (err) {
      console.error('Error uploading images:', err)
      alert('Failed to upload some images')
    } finally {
      setUploading(false)
    }
  }

  const toggleActive = async (id: string) => {
    try {
      const response = await fetch(`/api/images/${id}/toggle`, {
        method: 'PATCH',
      })

      if (!response.ok) throw new Error('Toggle failed')
      await fetchImages()
      showNotification('Updated! Slideshow will refresh shortly.')
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
      showNotification('Photo deleted! Slideshow will update automatically.')
    } catch (err) {
      console.error('Error deleting image:', err)
    }
  }

  const createCollection = async () => {
    if (!newCollectionName.trim()) {
      alert('Collection name is required')
      return
    }

    try {
      const response = await fetch('/api/collections', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: newCollectionName,
          description: newCollectionDescription,
        }),
      })

      if (!response.ok) throw new Error('Failed to create collection')
      await fetchCollections()
      setCreateCollectionOpen(false)
      setNewCollectionName('')
      setNewCollectionDescription('')
      showNotification('Collection created!')
    } catch (err) {
      console.error('Error creating collection:', err)
      alert('Failed to create collection')
    }
  }

  const deleteCollection = async (id: string) => {
    if (!confirm('Are you sure you want to delete this collection? Photos will not be deleted.')) return

    try {
      const response = await fetch(`/api/collections/${id}`, {
        method: 'DELETE',
      })

      if (!response.ok) throw new Error('Failed to delete collection')
      await fetchCollections()
      await fetchImages()
      if (activeCollectionId === id) {
        setActiveCollectionToSlideshow(null)
      }
      showNotification('Collection deleted!')
    } catch (err) {
      console.error('Error deleting collection:', err)
      alert('Failed to delete collection')
    }
  }

  const toggleImageInCollection = async (imageId: string, collectionId: string, isInCollection: boolean) => {
    try {
      const url = `/api/collections/${collectionId}/images/${imageId}`
      const response = await fetch(url, {
        method: isInCollection ? 'DELETE' : 'POST',
      })

      if (!response.ok) throw new Error('Failed to update collection')
      await fetchImages()
      showNotification(isInCollection ? 'Photo removed from collection!' : 'Photo added to collection!')
    } catch (err) {
      console.error('Error updating collection:', err)
      alert('Failed to update collection')
    }
  }

  const setActiveCollectionToSlideshow = async (collectionId: string | null) => {
    try {
      const response = await fetch('/api/slideshow/collection', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ collectionId }),
      })

      if (!response.ok) throw new Error('Failed to set active collection')
      setActiveCollectionId(collectionId)
      showNotification(collectionId ? 'Collection activated!' : 'Showing all active photos!')
    } catch (err) {
      console.error('Error setting active collection:', err)
      alert('Failed to set active collection')
    }
  }

  if (loading) {
    return (
      <Container size="xl" py="xl">
        <Stack align="center" justify="center" style={{ minHeight: '50vh' }}>
          <Loader size="lg" />
          <Text c="dimmed">Loading photos...</Text>
        </Stack>
      </Container>
    )
  }

  const currentImage = images.find(img => img.id === currentImageId)
  
  // Filter images by selected collection
  const filteredImages = filterCollectionId
    ? images.filter(img => img.collectionIds.includes(filterCollectionId))
    : images

  return (
    <Container size="xl" py="xl">
      {notification && (
        <Notification
          color="teal"
          title="Success"
          onClose={() => setNotification(null)}
          style={{ position: 'fixed', top: 90, right: 20, zIndex: 1000 }}
        >
          {notification}
        </Notification>
      )}
      
      <Group justify="space-between" mb="xl">
        <Title order={1}>Photo Gallery</Title>
        <FileButton onChange={setFiles} accept="image/*" multiple disabled={uploading}>
          {(props) => (
            <Button
              {...props}
              leftSection={<IconUpload size={18} />}
              loading={uploading}
              size="md"
            >
              {uploading ? 'Uploading...' : 'Upload Photos'}
            </Button>
          )}
        </FileButton>
      </Group>

      <Paper shadow="sm" p="md" mb="xl" withBorder>
        <Title order={3} mb="md">Slideshow Settings</Title>
        
        <Stack gap="md">
          <Box>
            <Text size="sm" fw={500} mb="xs">Currently Displaying:</Text>
            {currentImage ? (
              <Group gap="md">
                <MantineImage
                  src={currentImage.path}
                  alt={currentImage.originalName}
                  h={80}
                  w={120}
                  fit="cover"
                  radius="sm"
                />
                <Text size="sm">{currentImage.originalName}</Text>
              </Group>
            ) : (
              <Text size="sm" c="dimmed">No image currently displayed</Text>
            )}
          </Box>

          <Divider />

          <Box>
            <Text size="sm" fw={500} mb="xs">Active Collection</Text>
            <Text size="xs" c="dimmed" mb="sm">Choose which collection to display in the slideshow</Text>
            <Group gap="md">
              <Select
                value={activeCollectionId}
                onChange={setActiveCollectionToSlideshow}
                data={[
                  { value: '', label: 'All Active Photos' },
                  ...collections.map(c => ({ value: c.id, label: c.name }))
                ]}
                placeholder="Select collection"
                clearable
                leftSection={<IconFolder size={18} />}
                style={{ flex: 1 }}
              />
            </Group>
          </Box>

          <Divider />

          <Box>
            <Text size="sm" fw={500} mb="xs">Photo Duration</Text>
            <Text size="xs" c="dimmed" mb="sm">How long each photo stays on screen</Text>
            <Group gap="md" align="flex-end">
              <NumberInput
                value={durationValue}
                onChange={(val) => setDurationValue(typeof val === 'number' ? val : 1)}
                min={1}
                max={999}
                leftSection={<IconClock size={18} />}
                style={{ flex: 1, maxWidth: 150 }}
              />
              <Select
                value={durationUnit}
                onChange={(val) => setDurationUnit(val as TimeUnit)}
                data={[
                  { value: 'seconds', label: 'Seconds' },
                  { value: 'minutes', label: 'Minutes' },
                  { value: 'hours', label: 'Hours' },
                ]}
                style={{ flex: 1, maxWidth: 150 }}
              />
              <Button
                onClick={updateDuration}
                loading={durationSaving}
                variant="light"
              >
                Apply
              </Button>
            </Group>
          </Box>
        </Stack>
      </Paper>

      <Paper shadow="sm" p="md" mb="xl" withBorder>
        <Group justify="space-between" mb="md">
          <Title order={3}>Collections</Title>
          <Button
            leftSection={<IconFolderPlus size={18} />}
            onClick={() => setCreateCollectionOpen(true)}
            variant="light"
          >
            New Collection
          </Button>
        </Group>
        
        {collections.length === 0 ? (
          <Text size="sm" c="dimmed">No collections yet. Create one to organize your photos!</Text>
        ) : (
          <Group gap="xs">
            {collections.map((collection) => (
              <Badge
                key={collection.id}
                size="lg"
                variant={activeCollectionId === collection.id ? 'filled' : 'light'}
                color={activeCollectionId === collection.id ? 'green' : 'blue'}
                style={{ cursor: 'pointer' }}
                rightSection={
                  <ActionIcon
                    size="xs"
                    color="red"
                    radius="xl"
                    variant="transparent"
                    onClick={(e) => {
                      e.stopPropagation()
                      deleteCollection(collection.id)
                    }}
                  >
                    <IconTrash size={12} />
                  </ActionIcon>
                }
              >
                {collection.name}
              </Badge>
            ))}
          </Group>
        )}
      </Paper>

      <Group justify="space-between" mb="md">
        <Title order={3}>Photos</Title>
        <Select
          value={filterCollectionId}
          onChange={setFilterCollectionId}
          data={[
            { value: '', label: 'All Photos' },
            ...collections.map(c => ({ value: c.id, label: c.name }))
          ]}
          placeholder="Filter by collection"
          clearable
          leftSection={<IconFolder size={18} />}
          style={{ width: 250 }}
        />
      </Group>

      <Modal
        opened={createCollectionOpen}
        onClose={() => {
          setCreateCollectionOpen(false)
          setNewCollectionName('')
          setNewCollectionDescription('')
        }}
        title="Create New Collection"
      >
        <Stack gap="md">
          <TextInput
            label="Collection Name"
            placeholder="e.g., Vacation 2024"
            value={newCollectionName}
            onChange={(e) => setNewCollectionName(e.currentTarget.value)}
            required
          />
          <Textarea
            label="Description (optional)"
            placeholder="Add a description..."
            value={newCollectionDescription}
            onChange={(e) => setNewCollectionDescription(e.currentTarget.value)}
            minRows={3}
          />
          <Group justify="flex-end" gap="sm">
            <Button
              variant="subtle"
              onClick={() => {
                setCreateCollectionOpen(false)
                setNewCollectionName('')
                setNewCollectionDescription('')
              }}
            >
              Cancel
            </Button>
            <Button onClick={createCollection}>
              Create
            </Button>
          </Group>
        </Stack>
      </Modal>

      {filteredImages.length === 0 ? (
        <Stack align="center" justify="center" style={{ minHeight: '50vh' }} gap="md">
          <IconPhoto size={64} stroke={1.5} opacity={0.3} />
          <Title order={3} c="dimmed">
            {filterCollectionId ? 'No photos in this collection' : 'No photos yet'}
          </Title>
          <Text c="dimmed" size="sm">
            {filterCollectionId ? 'Add photos to this collection' : 'Click "Upload Photos" to get started'}
          </Text>
        </Stack>
      ) : (
        <SimpleGrid
          cols={{ base: 1, sm: 2, md: 3, lg: 4 }}
          spacing="lg"
        >
          {filteredImages.map((image) => (
            <Card key={image.id} shadow="sm" padding="lg" radius="md" withBorder>
              <Card.Section pos="relative">
                <MantineImage
                  src={image.path}
                  alt={image.originalName}
                  h={200}
                  fit="cover"
                />
                {!image.active && (
                  <Badge
                    color="gray"
                    size="lg"
                    pos="absolute"
                    top={10}
                    right={10}
                    variant="filled"
                  >
                    Hidden
                  </Badge>
                )}
                {image.id === currentImageId && (
                  <Badge
                    color="green"
                    size="lg"
                    pos="absolute"
                    top={10}
                    left={10}
                    variant="filled"
                  >
                    Now Playing
                  </Badge>
                )}
              </Card.Section>

              <Stack gap="xs" mt="md">
                <Text
                  size="sm"
                  fw={500}
                  lineClamp={1}
                  title={image.originalName}
                >
                  {image.originalName}
                </Text>

                {collections.length > 0 && (
                  <Box>
                    <Text size="xs" c="dimmed" mb={4}>Collections:</Text>
                    <Group gap={4}>
                      {collections.map((collection) => {
                        const isInCollection = image.collectionIds.includes(collection.id)
                        return (
                          <Chip
                            key={collection.id}
                            checked={isInCollection}
                            onChange={() => toggleImageInCollection(image.id, collection.id, isInCollection)}
                            size="xs"
                          >
                            {collection.name}
                          </Chip>
                        )
                      })}
                    </Group>
                  </Box>
                )}

                <Group gap="xs" grow>
                  <Button
                    variant="light"
                    color={image.active ? 'orange' : 'green'}
                    leftSection={image.active ? <IconEyeOff size={16} /> : <IconEye size={16} />}
                    onClick={() => toggleActive(image.id)}
                    size="xs"
                  >
                    {image.active ? 'Hide' : 'Show'}
                  </Button>
                  <Button
                    variant="light"
                    color="red"
                    leftSection={<IconTrash size={16} />}
                    onClick={() => deleteImage(image.id)}
                    size="xs"
                  >
                    Delete
                  </Button>
                </Group>
                {image.active && (
                  <Button
                    variant="filled"
                    color="blue"
                    leftSection={<IconPlayerPlay size={16} />}
                    onClick={() => showImageNow(image.id)}
                    size="xs"
                    fullWidth
                    disabled={image.id === currentImageId}
                  >
                    {image.id === currentImageId ? 'Currently Showing' : 'Show Now'}
                  </Button>
                )}
              </Stack>
            </Card>
          ))}
        </SimpleGrid>
      )}
    </Container>
  )
}

export default Admin

