/**
 * Optional TeX typesetting.
 *
 * Temml converts TeX to MathML without shipping fonts, and Chromium renders
 * MathML natively, so the printed page gets real fractions, radicals and
 * integrals without a LaTeX installation. The module is imported lazily and a
 * missing package is not an error: math then stays visible as styled source,
 * exactly as it did before typesetting existed.
 */

/** Cached result: a renderer, or null when the package is unavailable. */
let resolved

/**
 * Load the TeX renderer once per process.
 * @returns a function from TeX and display mode to markup, or null.
 */
export async function loadMathRenderer() {
  if (resolved !== undefined) return resolved
  try {
    const module = await import('temml')
    const temml = module.default ?? module
    const render = temml?.renderToString
    if (typeof render !== 'function') {
      resolved = null
      return null
    }
    resolved = (tex, display) => {
      try {
        const markup = render(tex, { displayMode: display === true, throwOnError: false, strict: false })
        return typeof markup === 'string' && markup !== '' ? markup : null
      } catch {
        return null
      }
    }
  } catch {
    resolved = null
  }
  return resolved
}

/**
 * Whether a TeX renderer is available without loading it again.
 * @returns true when the last load succeeded.
 */
export function hasMathRenderer() {
  return typeof resolved === 'function'
}
