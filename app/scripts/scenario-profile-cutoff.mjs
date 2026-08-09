export function profileKey(stationId, slot) {
  return `${stationId}:${slot}`
}

export function updateProfile(profileStats, snapshot) {
  const key = profileKey(snapshot.id, snapshot.slot)
  let profile = profileStats.get(key)
  if (!profile) {
    profile = {
      observations: 0,
      bikesSum: 0,
      docksSum: 0,
      empty: 0,
      full: 0,
      unavailable: 0,
    }
    profileStats.set(key, profile)
  }

  if (snapshot.currentState === 'unavailable') {
    profile.unavailable += 1
    return
  }

  profile.observations += 1
  profile.bikesSum += snapshot.availableBikes
  profile.docksSum += snapshot.availableDocks
  if (snapshot.currentState === 'empty') profile.empty += 1
  if (snapshot.currentState === 'full') profile.full += 1
}

export function createScenarioProfileStats(scenarios) {
  return new Map(scenarios.map((scenario) => [scenario.epoch, new Map()]))
}

export function updateScenarioProfileStats(profileStatsByScenario, scenarios, snapshot) {
  for (const scenario of scenarios) {
    // The replay snapshot itself is known at `scenario.epoch`, but its
    // historical baseline may only learn from observations strictly before
    // that bucket. This also excludes later observations in the same bucket.
    if (snapshot.epoch >= scenario.epoch) continue

    const profileStats = profileStatsByScenario.get(scenario.epoch)
    if (!profileStats) throw new Error(`Missing profile accumulator for replay scenario ${scenario.epoch}`)
    updateProfile(profileStats, snapshot)
  }
}
