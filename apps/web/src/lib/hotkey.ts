/**
 * Whether a key event is the K key. A Latin letter is matched by what it types, so Dvorak and Colemak users
 * get their "k"; anything else (an Arabic layout types "ل" on the physical K key) by the physical key, which
 * the layout cannot change. Matching `event.key` alone made Ctrl+K dead for anyone typing Arabic.
 */
export function isKKey(event: Pick<KeyboardEvent, 'key' | 'code'>): boolean {
  return /^[a-z]$/i.test(event.key) ? event.key.toLowerCase() === 'k' : event.code === 'KeyK';
}
