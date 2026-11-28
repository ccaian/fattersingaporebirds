const obsCache = new Map()
const taxonCache = new Map()
const taxonIdByNameCache = new Map()

const CLOUDFLARE_BLACKLIST_URL = 'https://borb-blacklist.ccaian3.workers.dev'
const LOCAL_BLACKLIST_KEY = 'borb_snake_blacklist_v1'

let remoteBlacklistEntries = []
let blacklistLoaded = false

function extractObservationId(entry) {
  if (typeof entry === 'number') return entry
  if (typeof entry === 'string') {
    const match = entry.match(/(\d+)/)
    return match ? Number(match[1]) : null
  }
  if (entry && typeof entry === 'object' && entry.observation_id != null) {
    return Number(entry.observation_id)
  }
  return null
}

function getLocalBlacklistEntries() {
  try {
    const raw = localStorage.getItem(LOCAL_BLACKLIST_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export async function loadBlacklist() {
  if (blacklistLoaded) return
  try {
    if (CLOUDFLARE_BLACKLIST_URL) {
      const res = await fetch(CLOUDFLARE_BLACKLIST_URL)
      if (res.ok) {
        const remoteData = await res.json()
        if (Array.isArray(remoteData)) {
          remoteBlacklistEntries = remoteData
            .map((item) => {
              const id = extractObservationId(item)
              return id
                ? { observation_id: id, reason: item.reason || 'Blacklisted' }
                : null
            })
            .filter(Boolean)
        }
      }
    }
  } catch (err) {
    console.warn('Could not load Cloudflare blacklist:', err)
  } finally {
    blacklistLoaded = true
  }
}

export function getBlacklistedIdSet() {
  const ids = new Set()
  for (const item of [...remoteBlacklistEntries, ...getLocalBlacklistEntries()]) {
    const id = extractObservationId(item)
    if (id) ids.add(id)
  }
  return ids
}

export async function addToBlacklist({ observationId, scientificName, reason }) {
  const id = extractObservationId(observationId)
  if (!id) return

  const payload = {
    observation_id: id,
    scientific_name: scientificName || null,
    reason: reason || 'Invalid photo',
    reported_at: new Date().toISOString().slice(0, 10),
  }

  const existing = getLocalBlacklistEntries().filter(
    (entry) => extractObservationId(entry) !== id
  )
  existing.push(payload)
  try {
    localStorage.setItem(LOCAL_BLACKLIST_KEY, JSON.stringify(existing))
  } catch (err) {
    console.error('Failed to save blacklist to localStorage:', err)
  }

  if (scientificName) {
    for (const key of obsCache.keys()) {
      if (key.startsWith(`${scientificName}::`)) {
        obsCache.delete(key)
      }
    }
  }

  if (CLOUDFLARE_BLACKLIST_URL) {
    try {
      await fetch(CLOUDFLARE_BLACKLIST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      remoteBlacklistEntries.push({
        observation_id: id,
        reason: payload.reason,
      })
    } catch (err) {
      console.error('Failed to sync blacklist to Cloudflare:', err)
    }
  }
}

async function resolveTaxonId(sciName) {
  const normalizedTarget = sciName.trim().toLowerCase()
  if (taxonIdByNameCache.has(normalizedTarget)) {
    return taxonIdByNameCache.get(normalizedTarget)
  }

  const params = new URLSearchParams({
    q: sciName,
    rank: 'species,subspecies',
    per_page: '10',
  })

  const res = await fetch(
    `https://api.inaturalist.org/v1/taxa?${params.toString()}`
  )
  if (!res.ok) return null

  const data = await res.json()
  const exactMatch = (data.results || []).find(
    (t) =>
      t.is_active !== false &&
      t.name &&
      t.name.trim().toLowerCase() === normalizedTarget
  )

  const resolvedId = exactMatch ? exactMatch.id : null
  taxonIdByNameCache.set(normalizedTarget, resolvedId)
  return resolvedId
}

const PLACE_IDS = {
  singapore: ['6734'],
  borneo: ['7319', '7045', '7145', '7237'],
  sundalandFallback: ['6734', '7319', '7045', '7145', '7237', '7155', '6966'],
}

const THAILAND_PLACE_ID = 6967

const EXCLUDED_KEYWORDS = [
  'roadkill',
  'road kill',
  'dor',
  'dead on road',
  'dead',
  'carcass',
  'flattened',
  'run over',
  'ran over',
  'squashed',
  'predation',
  'eating',
  'swallowing',
  'feeding on',
  'prey',
]

const KEYWORD_REGEX = new RegExp(
  `\\b(${EXCLUDED_KEYWORDS.map((k) => k.replace(/\s+/g, '\\s+')).join('|')})\\b`,
  'i'
)

function buildPlaceIdParam(regions) {
  const ids = []
  if (regions?.singapore) ids.push(...PLACE_IDS.singapore)
  if (regions?.borneo) ids.push(...PLACE_IDS.borneo)
  return ids.join(',')
}

function isThailandObservation(obs) {
  if (Array.isArray(obs.place_ids) && obs.place_ids.includes(THAILAND_PLACE_ID)) {
    return true
  }
  const pg = (obs.place_guess || '').trim()
  if (/\b(thailand|th)\s*$/i.test(pg) || /\bthailand\b/i.test(pg)) {
    return true
  }
  return false
}

function isLiveSingleSpecimen(obs) {
  if (Array.isArray(obs.annotations)) {
    const isDeadOrUnknown = obs.annotations.some(
      (ann) =>
        ann.controlled_attribute_id === 17 &&
        (ann.controlled_value_id === 19 || ann.controlled_value_id === 20)
    )
    if (isDeadOrUnknown) return false
  }

  const textParts = []
  if (obs.description) textParts.push(obs.description)
  if (Array.isArray(obs.tags)) textParts.push(...obs.tags)
  if (Array.isArray(obs.comments)) {
    for (const c of obs.comments) {
      if (c?.body) textParts.push(c.body)
    }
  }
  if (Array.isArray(obs.ofvs)) {
    for (const field of obs.ofvs) {
      if (field?.name) textParts.push(field.name)
      if (field?.value) textParts.push(String(field.value))
    }
  }

  const combinedText = textParts.join(' ')
  if (combinedText && KEYWORD_REGEX.test(combinedText)) {
    return false
  }

  return true
}

async function queryObservations(sciName, placeIdParam, excludeThailand = true) {
  await loadBlacklist()
  const blacklistedIds = getBlacklistedIdSet()
  const taxonId = await resolveTaxonId(sciName)

  const params = new URLSearchParams({
    quality_grade: 'research',
    photos: 'true',
    without_term_value_id: '19',
    per_page: '20',
    order_by: 'votes',
    order: 'desc',
  })

  if (taxonId) {
    params.set('taxon_id', String(taxonId))
  } else {
    params.set('taxon_name', sciName)
  }

  if (placeIdParam) {
    params.set('place_id', placeIdParam)
  }
  if (excludeThailand) {
    params.set('not_in_place', String(THAILAND_PLACE_ID))
  }

  const res = await fetch(
    `https://api.inaturalist.org/v1/observations?${params.toString()}`
  )
  if (!res.ok) {
    throw new Error(`iNaturalist API error: ${res.status}`)
  }

  const normalizedTarget = sciName.trim().toLowerCase()
  const data = await res.json()
  let results = (data.results || []).filter((obs) => {
    if (!obs.photos || obs.photos.length === 0) return false
    if (blacklistedIds.has(Number(obs.id))) return false

    const obsTaxonName = (obs.taxon?.name || '').trim().toLowerCase()
    if (obsTaxonName && obsTaxonName !== normalizedTarget) {
      return false
    }
    return true
  })

  if (excludeThailand) {
    const nonThai = results.filter((obs) => !isThailandObservation(obs))
    if (nonThai.length > 0) {
      results = nonThai
    }
  }

  const liveFiltered = results.filter(isLiveSingleSpecimen)
  return liveFiltered.length > 0 ? liveFiltered : results
}

export async function fetchSnakeRoundData(
  snake,
  regions = { singapore: true, borneo: true },
  options = {}
) {
  await loadBlacklist()
  const blacklistedIds = getBlacklistedIdSet()
  const excludeSet = new Set(
    (options.excludeObservationIds || []).map((id) => Number(id))
  )

  const sciName = snake.scientific_name
  const placeIdParam = buildPlaceIdParam(regions)
  const cacheKey = `${sciName}::${placeIdParam || 'global'}::noTH`

  let observations = obsCache.get(cacheKey)
  if (observations) {
    observations = observations.filter(
      (obs) => !blacklistedIds.has(Number(obs.id))
    )
  }

  if (!observations || observations.length === 0) {
    observations = await queryObservations(sciName, placeIdParam, true)

    if (observations.length === 0 && placeIdParam) {
      observations = await queryObservations(
        sciName,
        PLACE_IDS.sundalandFallback.join(','),
        true
      )
    }

    if (observations.length === 0) {
      observations = await queryObservations(sciName, '', true)
    }

    obsCache.set(cacheKey, observations)
  }

  if (observations.length === 0) {
    return null
  }

  // Prefer a different observation when refreshing photo for the same species
  const nonRepeated =
    excludeSet.size > 0
      ? observations.filter((obs) => !excludeSet.has(Number(obs.id)))
      : observations
  const candidatePool = nonRepeated.length > 0 ? nonRepeated : observations

  const chosenObs =
    candidatePool[Math.floor(Math.random() * candidatePool.length)]
  const chosenPhoto =
    chosenObs.photos[Math.floor(Math.random() * chosenObs.photos.length)]

  const photoUrl = chosenPhoto.url.replace('square', 'large')
  const placeGuess = chosenObs.place_guess || 'Location not recorded'
  const photographer = chosenObs.user?.login || 'unknown'

  let conservationStatus =
    chosenObs.taxon?.conservation_status?.status_name || null
  let wikipediaSummary = chosenObs.taxon?.wikipedia_summary || null

  const taxonId = chosenObs.taxon?.id
  if (taxonId && (!wikipediaSummary || !conservationStatus)) {
    let taxonDetails = taxonCache.get(taxonId)
    if (!taxonDetails) {
      try {
        const taxonRes = await fetch(
          `https://api.inaturalist.org/v1/taxa/${taxonId}`
        )
        if (taxonRes.ok) {
          const taxonJson = await taxonRes.json()
          taxonDetails = taxonJson.results?.[0] || null
          taxonCache.set(taxonId, taxonDetails)
        }
      } catch {
        // Ignore secondary taxon lookup failures
      }
    }

    if (taxonDetails) {
      if (!wikipediaSummary && taxonDetails.wikipedia_summary) {
        wikipediaSummary = taxonDetails.wikipedia_summary
      }
      if (!conservationStatus) {
        const cs =
          taxonDetails.conservation_status ||
          taxonDetails.conservation_statuses?.[0]
        if (cs) {
          conservationStatus = cs.status_name || cs.status || null
        }
      }
    }
  }

  const cleanSummary = wikipediaSummary
    ? wikipediaSummary.replace(/<[^>]*>/g, '').trim()
    : 'No Wikipedia summary available for this species.'

  return {
    observationId: chosenObs.id,
    photoUrl,
    placeGuess,
    photographer,
    conservationStatus: conservationStatus || 'Not Evaluated / Unlisted',
    wikipediaSummary: cleanSummary,
    observationUrl: `https://www.inaturalist.org/observations/${chosenObs.id}`,
  }
}