import { useState, useEffect, useCallback } from "react";
import { TodaygentMascot } from "./TodaygentMascot";
import { ShuffledCycler } from "../../utils/shuffledCycler";
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

const wordCycler = new ShuffledCycler([
  ...NORMAL_WORDS, ...OMINOUS_WORDS, ...PERMISSION_VIOLATIONS, ...SPECIALS,
]);

export function ThinkingIndicator() {
  const [word, setWord] = useState(() => wordCycler.next())
  const [fading, setFading] = useState(false)

  const cycleWord = useCallback(() => {
    setFading(true)
    setTimeout(() => {
      setWord(() => wordCycler.next())
      setFading(false)
    }, 200) // fade-out duration
  }, [])

  useEffect(() => {
    const interval = setInterval(cycleWord, 2300)
    return () => clearInterval(interval)
  }, [cycleWord])

  return (
    <div className="thinking-indicator">
      <TodaygentMascot state="thinking" size={40} />
      <span className={`thinking-indicator__word${fading ? " thinking-indicator__word--fading" : ""}`}>
        {word.charAt(0).toUpperCase() + word.slice(1)}...
      </span>
    </div>
  );
}
