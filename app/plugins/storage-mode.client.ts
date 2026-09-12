import { configureSnapshotPersistence } from '~/composables/useStationSnapshots'

export default defineNuxtPlugin(() => {
  // Set before any layout, page, or asynchronous snapshot consumer runs.
  const config = useRuntimeConfig().public
  configureSnapshotPersistence(config.storageMode !== 'aws' && !config.persistencePath)
})
