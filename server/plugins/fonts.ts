/**
 * Dela Gothic One for display, Inter 400-700 for text, and Noto Sans Malayalam
 * 400/700 for Malayalam, loaded WITHOUT blocking render: the print-media swap.
 * As a render-blocking stylesheet it cost ~1.9 s of first paint on a throttled
 * phone, and every face is display=swap with a system fallback anyway.
 *
 * Written into the HTML here rather than through app.head, because unhead
 * owns the attributes of what it renders: a later head update would set the
 * swapped `media` back to "print" and drop the fonts. The <noscript> copy
 * keeps the fonts for visitors without JavaScript.
 */
const FONTS = 'https://fonts.googleapis.com/css2?family=Dela+Gothic+One&family=Inter:wght@400;500;600;700&family=Noto+Sans+Malayalam:wght@400;700&display=swap'

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('render:html', (html) => {
    html.head.push(
      `<link rel="stylesheet" href="${FONTS}" media="print" onload="this.media='all'">`
      + `<noscript><link rel="stylesheet" href="${FONTS}"></noscript>`,
    )
  })
})
