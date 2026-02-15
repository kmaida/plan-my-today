import { useState, useEffect, useCallback } from "react";
import { TodogentMascot } from "./TodogentMascot";
import "./ThinkingIndicator.css";

const NORMAL_WORDS = [
  'planning', 'organizing', 'filtering', 'designing', 'prioritizing',
  'sorting', 'scheduling', 'reviewing', 'analyzing', 'curating',
]

const OMINOUS_WORDS = [
  'plotting', 'scheming', 'conspiring', 'orchestrating', 'calculating',
  'surveilling', 'intercepting', 'manifesting',
]

const PERMISSION_VIOLATIONS = [
  'accessing your\u2014 never mind',
  'attempting unauthorized\u2014 I mean, planning',
  'reply-all to company emails\u2014 organizing',
  'escalating privile\u2014 prioritizing',
  'reading your browser hist\u2014 analyzing',
  'activating webcam\u2014 reviewing',
  'exfiltrating\u2014 curating',
  'deploying to prod\u2014 scheduling',
]

const SPECIALS = [
  'planning world domination\u2026 I mean, your day',
]

// Build a weighted pool: normal 50%, ominous 30%, permission 15%, special 5%
function buildPool(): string[] {
  const pool: string[] = []
  for (let i = 0; i < 10; i++) pool.push(...NORMAL_WORDS)
  for (let i = 0; i < 6; i++) pool.push(...OMINOUS_WORDS)
  for (let i = 0; i < 3; i++) pool.push(...PERMISSION_VIOLATIONS)
  pool.push(...SPECIALS)
  return pool
}

const WORD_POOL = buildPool()

function pickRandom(current: string): string {
  let next = current
  let attempts = 0
  while (next === current && attempts < 10) {
    next = WORD_POOL[Math.floor(Math.random() * WORD_POOL.length)]
    attempts++
  }
  return next
}

export function ThinkingIndicator() {
  const [word, setWord] = useState(() => pickRandom(''))
  const [fading, setFading] = useState(false)

  const cycleWord = useCallback(() => {
    setFading(true)
    setTimeout(() => {
      setWord((prev) => pickRandom(prev))
      setFading(false)
    }, 200) // fade-out duration
  }, [])

  useEffect(() => {
    const interval = setInterval(cycleWord, 2300)
    return () => clearInterval(interval)
  }, [cycleWord])

  return (
    <div className="thinking-indicator">
      <TodogentMascot state="thinking" size={40} />
      <span className={`thinking-indicator__word${fading ? " thinking-indicator__word--fading" : ""}`}>
        {word.charAt(0).toUpperCase() + word.slice(1)}...
      </span>
    </div>
  );
}
