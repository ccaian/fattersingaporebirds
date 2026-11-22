import './App.css'
import { useState, useEffect, useMemo } from 'react'

const ROUND_OPTIONS = [20, 50, 100, 'All']
const RARITY_LEVELS = ['Very Common', 'Common', 'Uncommon', 'Rare', 'Very Rare']

// Returns { category, rarity } if local_status has valid data, or null if unmatched
function parseLocalStatus(localStatusRaw) {
  if (!localStatusRaw || typeof localStatusRaw !== 'string') return null
  const status = localStatusRaw.trim().toLowerCase()
  if (!status) return null

  if (status.includes('vagrant')) {
    return { category: 'vagrants', rarity: null }
  }

  const isLocal = status.includes('resident') || status.includes('introduced')
  const isMigrant = status.includes('migrant') || status.includes('visitor')
  if (!isLocal && !isMigrant) return null

  let rarity = null
  if (status.includes('very rare')) {
    rarity = 'Very Rare'
  } else if (status.includes('uncommon')) {
    rarity = 'Uncommon'
  } else if (status.includes('rare')) {
    rarity = 'Rare'
  } else if (status.includes('very common')) {
    rarity = 'Very Common'
  } else if (status.includes('common')) {
    rarity = 'Common'
  } 

  if (!rarity) return null

  return {
    category: isLocal ? 'local' : 'migrant',
    rarity,
  }
}

function matchesStatusFilter(localStatusRaw, filters) {
  const parsed = parseLocalStatus(localStatusRaw)
  if (!parsed) return false

  if (parsed.category === 'vagrants') {
    return filters.vagrants
  }
  return filters[parsed.category].includes(parsed.rarity)
}

function App() {
  const [screen, setScreen] = useState('start') // 'start' | 'playing' | 'summary'
  const [menuOpen, setMenuOpen] = useState(false)
  const [mode, setMode] = useState('photo') // 'photo' | 'audio'

  // Game Settings State
  const [maxRounds, setMaxRounds] = useState(20) // 20 | 50 | 100 | 'All'
  const [statusFilters, setStatusFilters] = useState({
    local: ['Very Common', 'Common'],
    migrant: ['Very Common', 'Common'],
    vagrants: false,
  })

  // Bird Data & Active Session State
  const [birds, setBirds] = useState([])
  const [sessionQueue, setSessionQueue] = useState([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [score, setScore] = useState(0)

  // Guessing, Autocomplete & Identification Pop-up State
  const [guess, setGuess] = useState('')
  const [showDropdown, setShowDropdown] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const [roundResult, setRoundResult] = useState(null) // null | { correct: boolean }
  const [showIdModal, setShowIdModal] = useState(false)

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}birdphotos/birds.json`)
      .then((res) => res.json())
      .then((data) => {
        const validBirds = data.filter(
          (b) =>
            b.photos &&
            b.photos.length > 0 &&
            parseLocalStatus(b.local_status) !== null
        )
        setBirds(validBirds)
      })
      .catch((err) => console.error('Failed to load birds.json:', err))
  }, [])

  const filteredBirds = useMemo(() => {
    return birds.filter((bird) =>
      matchesStatusFilter(bird.local_status, statusFilters)
    )
  }, [birds, statusFilters])

  const toggleRarity = (group, level) => {
    setStatusFilters((prev) => {
      const exists = prev[group].includes(level)
      const updated = exists
        ? prev[group].filter((item) => item !== level)
        : [...prev[group], level]
      return { ...prev, [group]: updated }
    })
  }

  const startNewGame = () => {
    if (filteredBirds.length === 0) return

    const shuffled = [...filteredBirds]
      .sort(() => Math.random() - 0.5)
      .map((bird) => ({
        bird,
        photo: bird.photos[Math.floor(Math.random() * bird.photos.length)],
      }))

    const limitedQueue =
      maxRounds === 'All' ? shuffled : shuffled.slice(0, maxRounds)

    setSessionQueue(limitedQueue)
    setCurrentIndex(0)
    setScore(0)
    setGuess('')
    setRoundResult(null)
    setShowIdModal(false)
    setScreen('playing')
  }

  const currentRound = sessionQueue[currentIndex] || null

  const nextRound = () => {
    setShowIdModal(false)
    setShowDropdown(false)
    setGuess('')
    setRoundResult(null)

    if (currentIndex + 1 >= sessionQueue.length) {
      setScreen('summary')
    } else {
      setCurrentIndex((prev) => prev + 1)
    }
  }

  const suggestions = useMemo(() => {
    const query = guess.trim().toLowerCase()
    if (!query) return []
    return birds
      .map((b) => b.bird_name)
      .filter((name) => name.toLowerCase().includes(query))
      .slice(0, 8)
  }, [guess, birds])

  const checkAnswer = (submittedText) => {
    if (!currentRound || roundResult) return
    const cleaned = submittedText.trim().toLowerCase()
    if (!cleaned) return

    const isCorrect = cleaned === currentRound.bird.bird_name.toLowerCase()
    if (isCorrect) {
      setScore((s) => s + 1)
    }
    setRoundResult({ correct: isCorrect })
    setShowDropdown(false)
  }

  const handleFormSubmit = (e) => {
    e.preventDefault()
    if (roundResult) {
      nextRound()
      return
    }
    if (showDropdown && suggestions.length > 0) {
      const selected = suggestions[highlightedIndex]
      setGuess(selected)
      checkAnswer(selected)
    } else {
      checkAnswer(guess)
    }
  }

  const handleKeyDown = (e) => {
    if (!showDropdown || suggestions.length === 0) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightedIndex((prev) => (prev + 1) % suggestions.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightedIndex((prev) =>
        prev === 0 ? suggestions.length - 1 : prev - 1
      )
    } else if (e.key === 'Escape') {
      setShowDropdown(false)
    }
  }

  const handleBack = () => {
    setMenuOpen(false)
    setShowIdModal(false)
    setScreen('start')
  }

  return (
    <main className={`game-card ${screen === 'playing' ? 'game-card--playing' : ''}`}>
      {screen === 'start' && (
        <>
          <div className="start-header">
            <h2 className="start-title">BORB!</h2>
            <p className="start-subtitle">
              ({birds.length} total species in database)
            </p>
          </div>

          <div className="settings-grid">
            {/* BOX 1: NUMBER OF ROUNDS */}
            <section className="setting-box">
              <h3 className="setting-box-title">Rounds</h3>
              <div className="rounds-options">
                {ROUND_OPTIONS.map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    className={`choice-tile ${
                      maxRounds === opt ? 'choice-tile--selected' : ''
                    }`}
                    onClick={() => setMaxRounds(opt)}
                  >
                    {opt === 'All' ? 'All!' : opt}
                  </button>
                ))}
              </div>
            </section>

            {/* BOX 2: LOCAL STATUS CHECKLIST */}
            <section className="setting-box">
              <h3 className="setting-box-title">Local Status</h3>

              <div className="status-columns">
                {/* Local Species Checklist */}
                <div>
                  <div className="status-group-header">
                    <span>Local</span>
                  </div>
                  {RARITY_LEVELS.map((level) => (
                    <label key={`local-${level}`} className="checklist-item">
                      <input
                        type="checkbox"
                        checked={statusFilters.local.includes(level)}
                        onChange={() => toggleRarity('local', level)}
                      />
                      <span>{level}</span>
                    </label>
                  ))}
                </div>

                {/* Migrant Species Checklist */}
                <div>
                  <div className="status-group-header">
                    <span>Migrant</span>
                  </div>
                  {RARITY_LEVELS.map((level) => (
                    <label key={`migrant-${level}`} className="checklist-item">
                      <input
                        type="checkbox"
                        checked={statusFilters.migrant.includes(level)}
                        onChange={() => toggleRarity('migrant', level)}
                      />
                      <span>{level}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="vagrant-row">
                <label className="checklist-item">
                  <input
                    type="checkbox"
                    checked={statusFilters.vagrants}
                    onChange={() =>
                      setStatusFilters((prev) => ({
                        ...prev,
                        vagrants: !prev.vagrants,
                      }))
                    }
                  />
                  <span>Vagrants</span>
                </label>

                <span className="pool-counter">
                  {filteredBirds.length} species selected
                </span>
              </div>
            </section>
          </div>

          <div className="card-footer">
            <button
              type="button"
              className="primary-button"
              onClick={startNewGame}
              disabled={filteredBirds.length === 0}
            >
              {filteredBirds.length === 0
                ? 'Select at least 1 status'
                : `Start Game (${
                    maxRounds === 'All'
                      ? filteredBirds.length
                      : Math.min(maxRounds, filteredBirds.length)
                  } Rounds)`}
            </button>
          </div>
        </>
      )}

      {screen === 'playing' && currentRound && (
        <>
          {/* 1. TOP 3-PART HEADER */}
          <header className="play-header">
            <button
              type="button"
              className="header-icon-btn header-icon-btn--left"
              onClick={handleBack}
              title="Back to Start"
            >
              ←
            </button>

            <div className="header-title-box">
              <span className="header-subtitle">
                ROUND {currentIndex + 1} OF {sessionQueue.length} • SCORE: {score}
              </span>
              <span className="header-title">
                {roundResult ? currentRound.bird.bird_name : 'Mystery Bird'}
              </span>
            </div>

            <button
              type="button"
              className="header-icon-btn header-icon-btn--right"
              onClick={() => setMenuOpen((prev) => !prev)}
              title="Menu"
            >
              ☰
            </button>
          </header>

          {/* Hamburger Dropdown Menu */}
          {menuOpen && (
            <nav className="header-menu">
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                }}
              >
                Settings
              </button>
              <button
                type="button"
                className="menu-item"
                onClick={handleBack}
              >
                Quit to Title
              </button>
            </nav>
          )}

          {/* 2. MIDDLE PHOTO / MEDIA BOX */}
          <section className="photo-box">
            {mode === 'photo' ? (
              <>
                <img
                  src={`${import.meta.env.BASE_URL}birdphotos/${currentRound.photo.local_path}`}
                  alt=""
                  aria-hidden="true"
                  className="photo-backdrop"
                />
                <img
                  src={`${import.meta.env.BASE_URL}birdphotos/${currentRound.photo.local_path}`}
                  alt="Mystery bird"
                  className="photo-foreground"
                />
              </>
            ) : (
              <button type="button" className="primary-button">
                ▶ Play Bird Call (Coming Soon)
              </button>
            )}

            {/* Monochrome Answer Reveal Pop-up + Local Status + Info Button */}
            {roundResult && (
              <div className="reveal-banner">
                <div className="reveal-details">
                  <div className="reveal-status-row">
                    <span
                      className={`status-tag ${
                        roundResult.correct
                          ? 'status-tag--correct'
                          : 'status-tag--wrong'
                      }`}
                    >
                      {roundResult.correct ? 'Correct' : 'Incorrect'}
                    </span>
                    <span className="reveal-bird-name">
                      {currentRound.bird.bird_name}
                    </span>
                  </div>
                  <div className="reveal-caption">
                    {currentRound.photo.caption}
                  </div>
                  <div className="reveal-local-status">
                    {currentRound.bird.local_status}
                  </div>
                </div>

                <button
                  type="button"
                  className="info-icon-btn"
                  onClick={() => setShowIdModal(true)}
                  title="View Identification Notes"
                >
                  i
                </button>
              </div>
            )}

            {/* Identification Field Guide Pop-up Modal */}
            {showIdModal && (
              <div
                className="id-modal-backdrop"
                onClick={() => setShowIdModal(false)}
              >
                <div
                  className="id-modal"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="id-modal-header">
                    <span>Field Guide • Identification</span>
                    <button
                      type="button"
                      className="id-modal-close"
                      onClick={() => setShowIdModal(false)}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="id-modal-body">
                    <div className="id-modal-meta">
                      {currentRound.bird.bird_name}
                    </div>
                    <p>
                      {currentRound.bird.identification ||
                        'No identification notes available for this species.'}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* 3. BOTTOM CONTROLS BOX */}
          <form className="controls-box" onSubmit={handleFormSubmit}>
            <div className="autocomplete-wrapper">
              {showDropdown && suggestions.length > 0 && !roundResult && (
                <ul className="autocomplete-list">
                  {suggestions.map((name, idx) => (
                    <li
                      key={name}
                      className={`autocomplete-item ${
                        idx === highlightedIndex ? 'autocomplete-item--active' : ''
                      }`}
                      onMouseDown={() => {
                        setGuess(name)
                        setShowDropdown(false)
                      }}
                    >
                      {name}
                    </li>
                  ))}
                </ul>
              )}

              <input
                type="text"
                className="guess-input"
                placeholder="Type bird name..."
                value={guess}
                disabled={Boolean(roundResult)}
                onFocus={() => setShowDropdown(true)}
                onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
                onKeyDown={handleKeyDown}
                onChange={(e) => {
                  setGuess(e.target.value)
                  setHighlightedIndex(0)
                  setShowDropdown(true)
                }}
              />
            </div>

            <div className="controls-buttons">
              {!roundResult ? (
                <>
                  <button type="submit" className="primary-button">
                    Submit Guess
                  </button>
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => {
                      setRoundResult({ correct: false })
                      setShowDropdown(false)
                    }}
                  >
                    Skip
                  </button>
                </>
              ) : (
                <button type="button" className="primary-button" onClick={nextRound}>
                  {currentIndex + 1 >= sessionQueue.length
                    ? 'Finish Expedition →'
                    : 'Next Bird →'}
                </button>
              )}
            </div>
          </form>
        </>
      )}

      {screen === 'summary' && (
        <>
          <div className="start-header">
            <h2 className="start-title">Expedition Complete</h2>
            <p className="start-subtitle">Final Field Report</p>
          </div>

          <div style={{ margin: 'auto 0' }}>
            <div
              style={{
                fontSize: '2.5rem',
                fontWeight: 900,
                fontFamily: 'ui-monospace, monospace',
              }}
            >
              {score} / {sessionQueue.length}
            </div>
            <p style={{ marginTop: '0.5rem', color: '#334155', fontWeight: 600 }}>
              {Math.round((score / Math.max(sessionQueue.length, 1)) * 100)}% Accuracy
            </p>
          </div>

          <div className="card-footer">
            <button
              type="button"
              className="primary-button"
              onClick={handleBack}
            >
              Back to Settings
            </button>
          </div>
        </>
      )}
    </main>
  )
}

export default App