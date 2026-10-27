/**
 * Country and region flags (flag-icons by Lipis, MIT) served from /flags/<code>.svg.
 * Names come from the browser's own locale data where the code is an ISO region.
 */
export const FLAG_CODES: readonly string[] = [
  'ad', 'ae', 'af', 'ag', 'ai', 'al', 'am', 'ao', 'aq', 'ar', 'arab', 'as', 'asean', 'at', 'au', 'aw',
  'ax', 'az', 'ba', 'bb', 'bd', 'be', 'bf', 'bg', 'bh', 'bi', 'bj', 'bl', 'bm', 'bn', 'bo', 'bq',
  'br', 'bs', 'bt', 'bv', 'bw', 'by', 'bz', 'ca', 'cc', 'cd', 'cefta', 'cf', 'cg', 'ch', 'ci', 'ck',
  'cl', 'cm', 'cn', 'co', 'cp', 'cr', 'cu', 'cv', 'cw', 'cx', 'cy', 'cz', 'de', 'dg', 'dj', 'dk',
  'dm', 'do', 'dz', 'eac', 'ec', 'ee', 'eg', 'eh', 'er', 'es', 'es-ct', 'es-ga', 'es-pv', 'et', 'eu', 'fi',
  'fj', 'fk', 'fm', 'fo', 'fr', 'ga', 'gb', 'gb-eng', 'gb-nir', 'gb-sct', 'gb-wls', 'gd', 'ge', 'gf', 'gg', 'gh',
  'gi', 'gl', 'gm', 'gn', 'gp', 'gq', 'gr', 'gs', 'gt', 'gu', 'gw', 'gy', 'hk', 'hm', 'hn', 'hr',
  'ht', 'hu', 'ic', 'id', 'ie', 'il', 'im', 'in', 'io', 'iq', 'ir', 'is', 'it', 'je', 'jm', 'jo',
  'jp', 'ke', 'kg', 'kh', 'ki', 'km', 'kn', 'kp', 'kr', 'kw', 'ky', 'kz', 'la', 'lb', 'lc', 'li',
  'lk', 'lr', 'ls', 'lt', 'lu', 'lv', 'ly', 'ma', 'mc', 'md', 'me', 'mf', 'mg', 'mh', 'mk', 'ml',
  'mm', 'mn', 'mo', 'mp', 'mq', 'mr', 'ms', 'mt', 'mu', 'mv', 'mw', 'mx', 'my', 'mz', 'na', 'nc',
  'ne', 'nf', 'ng', 'ni', 'nl', 'no', 'np', 'nr', 'nu', 'nz', 'om', 'pa', 'pc', 'pe', 'pf', 'pg',
  'ph', 'pk', 'pl', 'pm', 'pn', 'pr', 'ps', 'pt', 'pw', 'py', 'qa', 're', 'ro', 'rs', 'ru', 'rw',
  'sa', 'sb', 'sc', 'sd', 'se', 'sg', 'sh', 'sh-ac', 'sh-hl', 'sh-ta', 'si', 'sj', 'sk', 'sl', 'sm', 'sn',
  'so', 'sr', 'ss', 'st', 'sv', 'sx', 'sy', 'sz', 'tc', 'td', 'tf', 'tg', 'th', 'tj', 'tk', 'tl',
  'tm', 'tn', 'to', 'tr', 'tt', 'tv', 'tw', 'tz', 'ua', 'ug', 'um', 'un', 'us', 'uy', 'uz', 'va',
  'vc', 've', 'vg', 'vi', 'vn', 'vu', 'wf', 'ws', 'xk', 'xx', 'ye', 'yt', 'za', 'zm', 'zw',
]

const SPECIAL_NAMES: Record<string, string> = {
  'arab': 'Arab League',
  'asean': 'ASEAN',
  'cefta': 'CEFTA',
  'eac': 'East African Community',
  'es-ct': 'Catalonia',
  'es-ga': 'Galicia',
  'es-pv': 'Basque Country',
  'gb-eng': 'England',
  'gb-nir': 'Northern Ireland',
  'gb-sct': 'Scotland',
  'gb-wls': 'Wales',
  'sh-ac': 'Ascension Island',
  'sh-hl': 'Saint Helena',
  'sh-ta': 'Tristan da Cunha',
  'xx': 'Unknown'
}

let display: Intl.DisplayNames | null | undefined

export function flagName(code: string): string {
  if (SPECIAL_NAMES[code]) return SPECIAL_NAMES[code]
  if (display === undefined) {
    try {
      display = new Intl.DisplayNames(['en'], { type: 'region' })
    } catch {
      display = null
    }
  }
  try {
    return display?.of(code.toUpperCase()) ?? code.toUpperCase()
  } catch {
    return code.toUpperCase()
  }
}

export const flagUrl = (code: string) => `/flags/${code}.svg`

export interface FlagItem {
  code: string
  name: string
}

export function flagItems(): FlagItem[] {
  return FLAG_CODES.filter((c) => c !== 'xx').map((code) => ({ code, name: flagName(code) })).sort((a, b) => a.name.localeCompare(b.name))
}
