import { useEffect } from 'react'
import { Alert, Box, Stack, Text, Title } from '@mantine/core'
import { QRCodeSVG } from 'qrcode.react'
import type { SetupState } from '../setup/types'
import type { Screen } from '../setup/screenFor'
import { wifiQrPayload } from '../setup/wifiQr'

const READY_CARD_MS = 60_000

interface SetupProps {
  state: SetupState
  screen: Exclude<Screen, 'slideshow'>
  onDismiss: () => void
}

function Qr({ value }: { value: string }) {
  return (
    <Box p="md" style={{ background: '#fff', borderRadius: 12, lineHeight: 0 }}>
      <QRCodeSVG value={value} size={260} level="M" />
    </Box>
  )
}

function ErrorBanner({ message }: { message?: string }) {
  if (!message) return null
  return (
    <Alert color="red" variant="filled" title="Something went wrong">
      <Text size="xl">{message}</Text>
    </Alert>
  )
}

function WifiInstructions({ state }: { state: SetupState }) {
  const { hotspot } = state
  return (
    <>
      <Title order={1} fz={56}>Welcome to your photo frame</Title>
      <ErrorBanner message={state.lastError} />
      <div style={{ display: 'flex', gap: 48, alignItems: 'center', flexWrap: 'wrap' }}>
        <Stack gap="lg" style={{ flex: 1, minWidth: 360 }}>
          <Text fz={32}>1. On your phone, join the WiFi network</Text>
          {hotspot ? (
            <Stack gap="xs" pl="lg">
              <Text fz={44} fw={700}>{hotspot.ssid}</Text>
              <Text fz={44} fw={700} ff="monospace">{hotspot.password}</Text>
            </Stack>
          ) : (
            <Text fz={44} fw={700} pl="lg">Getting ready…</Text>
          )}
          <Text fz={32}>2. A setup page opens automatically (or open http://10.42.0.1)</Text>
          <Text fz={32}>3. Pick your home WiFi and enter its password</Text>
        </Stack>
        {hotspot && <Qr value={wifiQrPayload(hotspot.ssid, hotspot.password)} />}
      </div>
    </>
  )
}

function TailscaleLogin({ state }: { state: SetupState }) {
  const url = state.tailscaleLoginUrl
  return (
    <>
      <Title order={1} fz={56}>Connect your frame to Tailscale</Title>
      <ErrorBanner message={state.lastError} />
      {url ? (
        <Stack gap="lg" align="center">
          <Text fz={32}>Scan this code with your phone and sign in to Tailscale</Text>
          <Qr value={url} />
          <Text fz={24} ff="monospace" style={{ wordBreak: 'break-all' }}>{url}</Text>
        </Stack>
      ) : (
        <Text fz={40}>Getting a sign-in link…</Text>
      )}
      <Text fz={28} c="dimmed">
        Afterwards, share this frame with the person who set it up: Tailscale admin console → Machines → this frame → Share.
      </Text>
    </>
  )
}

function ReadyCard({ state, onDismiss }: { state: SetupState; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, READY_CARD_MS)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('keydown', onKey)
    }
  }, [onDismiss])

  const mdnsUrl = `http://${state.addresses.mdns}:3000`
  const tailnet = state.addresses.tailnet
  return (
    <>
      <Title order={1} fz={56}>You're all set</Title>
      <div style={{ display: 'flex', gap: 48, alignItems: 'center', flexWrap: 'wrap' }}>
        <Stack gap="lg" style={{ flex: 1, minWidth: 360 }}>
          <Text fz={44} fw={700} ff="monospace">{mdnsUrl}</Text>
          {tailnet && <Text fz={36} ff="monospace">{`http://${tailnet}:3000`}</Text>}
          <Text fz={32}>Add photos from your phone: open this address while on the same WiFi.</Text>
        </Stack>
        <Qr value={mdnsUrl} />
      </div>
    </>
  )
}

export default function Setup({ state, screen, onDismiss }: SetupProps) {
  return (
    <Box
      onClick={screen === 'ready-card' ? onDismiss : undefined}
      style={{
        minHeight: '100vh',
        background: '#101113',
        color: '#f1f3f5',
        padding: '64px 80px',
        boxSizing: 'border-box',
      }}
    >
      <Stack gap={40}>
        {screen === 'wifi-instructions' && <WifiInstructions state={state} />}
        {screen === 'tailscale-login' && <TailscaleLogin state={state} />}
        {screen === 'ready-card' && <ReadyCard state={state} onDismiss={onDismiss} />}
      </Stack>
    </Box>
  )
}
