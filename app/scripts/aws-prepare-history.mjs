import { syncOperatorSeed } from './aws-sync-operator-seed.mjs'
if (!process.env.SITE_BUCKET) throw new Error('SITE_BUCKET is required')
await syncOperatorSeed(process.env.SITE_BUCKET)
