import type { ModuleId, ModuleMeta } from './types'

export const MODULES: ModuleMeta[] = [
  { id: 'foundations', title: 'Foundations', tagline: 'What system design is and how to approach it', color: '#7c9cff' },
  { id: 'databases', title: 'Databases', tagline: 'Relational, isolation, scaling, sharding, NoSQL', color: '#4fd1c5' },
  { id: 'caching', title: 'Caching', tagline: 'Speed through memory, at every level', color: '#f6ad55' },
  { id: 'messaging', title: 'Messaging', tagline: 'Brokers, streams, Kafka, realtime pub/sub', color: '#f687b3' },
  { id: 'resilience', title: 'Resilience', tagline: 'Load balancers, circuit breakers, recovery, leaders', color: '#68d391' },
  { id: 'building-blocks', title: 'Building Blocks', tagline: 'Protocols, blob storage, bloom filters, hashing, big data', color: '#b794f4' },
  { id: 'case-studies', title: 'Case Studies', tagline: 'Design real systems end to end', color: '#fc8181' },
]

export const MODULE_BY_ID: Record<ModuleId, ModuleMeta> = Object.fromEntries(
  MODULES.map((m) => [m.id, m]),
) as Record<ModuleId, ModuleMeta>
