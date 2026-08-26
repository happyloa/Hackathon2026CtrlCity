function round(value, decimals = 1) {
  const scale = 10 ** decimals
  return Math.round(value * scale) / scale
}

function profileKey(stationId, weekday, hour) {
  return `${stationId}:${weekday}:${hour}`
}

export function createStationPopularityAccumulator() {
  return {
    profiles: new Map(),
  }
}

export function updateStationPopularity(accumulator, snapshot) {
  if (snapshot.currentState === 'unavailable') return
  const weekday = Number(snapshot.weekday)
  const hour = Math.floor(Number(snapshot.slot) / 2)
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6 || !Number.isInteger(hour) || hour < 0 || hour > 23) return

  const key = profileKey(snapshot.id, weekday, hour)
  let profile = accumulator.profiles.get(key)
  if (!profile) {
    profile = {
      bikesSum: 0,
      bikesSquaredSum: 0,
      docksSum: 0,
      docksSquaredSum: 0,
      observations: 0,
      sampleDays: 0,
      lastDate: '',
    }
    accumulator.profiles.set(key, profile)
  }

  const date = String(snapshot.at).slice(0, 10)
  if (date && profile.lastDate !== date) {
    profile.sampleDays += 1
    profile.lastDate = date
  }
  profile.observations += 1
  const bikes = Math.max(0, snapshot.availableBikes)
  const docks = Math.max(0, snapshot.availableDocks)
  profile.bikesSum += bikes
  profile.bikesSquaredSum += bikes ** 2
  profile.docksSum += docks
  profile.docksSquaredSum += docks ** 2
}

function standardDeviation(sum, squaredSum, observations) {
  if (!observations) return 0
  const mean = sum / observations
  return Math.sqrt(Math.max(0, squaredSum / observations - mean ** 2))
}

export function createCentralStationPopularityAccumulator(momentsAccumulator) {
  const bounds = new Map()
  for (const [key, profile] of momentsAccumulator.profiles) {
    const meanBikes = profile.bikesSum / profile.observations
    const meanDocks = profile.docksSum / profile.observations
    const bikesDeviation = standardDeviation(profile.bikesSum, profile.bikesSquaredSum, profile.observations)
    const docksDeviation = standardDeviation(profile.docksSum, profile.docksSquaredSum, profile.observations)
    bounds.set(key, {
      sampleDays: profile.sampleDays,
      bikesMinimum: meanBikes - bikesDeviation,
      bikesMaximum: meanBikes + bikesDeviation,
      docksMinimum: meanDocks - docksDeviation,
      docksMaximum: meanDocks + docksDeviation,
    })
  }
  return { bounds, profiles: new Map() }
}

export function updateCentralStationPopularity(accumulator, snapshot) {
  if (snapshot.currentState === 'unavailable') return
  const weekday = Number(snapshot.weekday)
  const hour = Math.floor(Number(snapshot.slot) / 2)
  const key = profileKey(snapshot.id, weekday, hour)
  const bounds = accumulator.bounds.get(key)
  if (!bounds) return

  let profile = accumulator.profiles.get(key)
  if (!profile) {
    profile = { bikesSum: 0, bikesCount: 0, docksSum: 0, docksCount: 0, sampleDays: bounds.sampleDays }
    accumulator.profiles.set(key, profile)
  }
  const bikes = Math.max(0, snapshot.availableBikes)
  const docks = Math.max(0, snapshot.availableDocks)
  if (bikes >= bounds.bikesMinimum && bikes <= bounds.bikesMaximum) {
    profile.bikesSum += bikes
    profile.bikesCount += 1
  }
  if (docks >= bounds.docksMinimum && docks <= bounds.docksMaximum) {
    profile.docksSum += docks
    profile.docksCount += 1
  }
}

export function stationPopularityProfile(accumulator, stationId) {
  return Array.from({ length: 7 }, (_, weekday) => (
    Array.from({ length: 24 }, (_, hour) => {
      const profile = accumulator.profiles.get(profileKey(stationId, weekday, hour))
      if (!profile?.sampleDays || !profile.bikesCount || !profile.docksCount) return null
      return [
        profile.sampleDays,
        round(profile.bikesSum / profile.bikesCount),
        round(profile.docksSum / profile.docksCount),
      ]
    })
  ))
}
