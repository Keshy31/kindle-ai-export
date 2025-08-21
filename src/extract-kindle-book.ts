import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import { input } from '@inquirer/prompts'
import delay from 'delay'
import { chromium, type Locator, type Page, type Response } from 'playwright'

import type { BookInfo, BookMeta, BookMetadata, PageChunk } from './types'
import {
  assert,
  deromanize,
  getEnv,
  normalizeAuthors,
  parseJsonpResponse
} from './utils'

interface PageNav {
  page?: number
  location?: number
  total: number
}

interface TocItem extends PageNav {
  title: string
  locator?: Locator
}

async function extractBook(page: Page, asin: string) {
  assert(asin, 'ASIN is required')

  const outDir = path.join('out', asin)
  const pageScreenshotsDir = path.join(outDir, 'pages')
  await fs.mkdir(pageScreenshotsDir, { recursive: true })

  const krRendererMainImageSelector = '#kr-renderer .kg-full-page-img img'
  const bookReaderUrl = `https://read.amazon.com/?asin=${asin}`

  let info: BookInfo | undefined
  let meta: BookMeta | undefined

  const responseHandler = async (response: Response) => {
    try {
      const status = response.status()
      if (status !== 200) return

      const url = new URL(response.url())
      if (
        url.hostname === 'read.amazon.com' &&
        url.pathname === '/service/mobile/reader/startReading' &&
        url.searchParams.get('asin')?.toLowerCase() === asin.toLowerCase()
      ) {
        const body: any = await response.json()
        delete body.karamelToken
        delete body.metadataUrl
        delete body.YJFormatVersion
        info = body
      } else if (url.pathname.endsWith('YJmetadata.jsonp')) {
        const body = await response.text()
        const metadata = parseJsonpResponse<any>(body)
        if (metadata.asin !== asin) return
        delete metadata.cpr
        if (Array.isArray(metadata.authorsList)) {
          metadata.authorsList = normalizeAuthors(metadata.authorsList)
        }
        meta = metadata
      }
    } catch {}
  }
  page.on('response', responseHandler)

  await page.goto(bookReaderUrl, { timeout: 30_000 })

  if (/\/ap\/signin/g.test(new URL(page.url()).pathname)) {
    page.removeListener('response', responseHandler)
    throw new Error('Login session expired or invalid.')
  }

  // await page.goto('https://read.amazon.com/landing')
  // await page.locator('[id="top-sign-in-btn"]').click()
  // await page.waitForURL('**/signin')

  async function updateSettings() {
    await page
      .locator('ion-button[item-i-d="top_menu_reader_settings"]')
      .click()

    await delay(500)

    // Change font to Amazon Ember
    await page.locator('#AmazonEmber').click()

    // Change layout to single column
    await page
      .locator('span[aria-label="Single Column"]')
      .click()

    await page
      .locator('ion-button[item-i-d="top_menu_reader_settings"]')
      .click()
    await delay(1000)
  }

  async function goToPage(pageNumber: number) {
    await delay(1000)
    await page.locator('#reader-header').hover({ force: true })
    await delay(200)
    await page.locator('ion-button[item-i-d="top_menu_navigation_menu"]').click()
    await delay(1000)
    await page
      .locator('ion-item[role="listitem"]', { hasText: 'Go to Page' })
      .click()
    await page
      .locator('ion-modal input[placeholder="page number"]')
      .fill(`${pageNumber}`)
    // await page.locator('ion-modal button', { hasText: 'Go' }).click()
    await page
      .locator('ion-modal ion-button[item-i-d="go-to-modal-go-button"]')
      .click()
    await delay(1000)
  }

  async function getPageNav() {
    const footerText = await page
      .locator('ion-title[item-i-d="reader-footer-title"] .text-div')
      .textContent()
    return parsePageNav(footerText)
  }

  async function ensureFixedHeaderUI() {
    await page.locator('.top-chrome').evaluate((el) => {
      el.style.transition = 'none'
      el.style.transform = 'none'
    })
  }

  async function dismissPossibleAlert() {
    const $alertNo = page.locator('ion-alert button', { hasText: 'No' })
    if (await $alertNo.isVisible()) {
      $alertNo.click()
    }
  }

  await dismissPossibleAlert()
  await ensureFixedHeaderUI()
  await updateSettings()

  const initialPageNav = await getPageNav()

  await page
    .locator('ion-button[item-i-d="top_menu_table_of_contents"]')
    .click()

  await delay(1000)

  const $tocItems = await page.locator('ion-list ion-item.toc-item').all()
  const tocItems: Array<TocItem> = []

  console.warn(`initializing ${$tocItems.length} TOC items...`)
  for (const tocItem of $tocItems) {
    await tocItem.scrollIntoViewIfNeeded()

    const title = await tocItem.locator('button.toc-item-button').getAttribute('aria-label')
    assert(title)

    await tocItem.locator('button.toc-item-button').click()
    await delay(250)

    const pageNav = await getPageNav()
    assert(pageNav)

    tocItems.push({
      title,
      ...pageNav,
      locator: tocItem
    })

    console.warn({ title, ...pageNav })

    // if (pageNav.page !== undefined) {
    //   break
    // }

    if (pageNav.page !== undefined && pageNav.page >= pageNav.total) {
      break
    }
  }

  const parsedToc = parseTocItems(tocItems)
  const toc: TocItem[] = tocItems.map(({ locator: _, ...tocItem }) => tocItem)

  const total = parsedToc.firstPageTocItem.total
  const pagePadding = `${total * 2}`.length
  await parsedToc.firstPageTocItem.locator!.scrollIntoViewIfNeeded()
  await parsedToc.firstPageTocItem.locator!.locator('button.toc-item-button').click()

  const totalContentPages = Math.min(
    parsedToc.afterLastPageTocItem?.page
      ? parsedToc.afterLastPageTocItem!.page
      : total,
    total
  )
  assert(totalContentPages > 0, 'No content pages found')

  // Close the TOC menu by clicking the TOC button again
  await page.locator('ion-button[item-i-d="top_menu_table_of_contents"]').click()
  await delay(1000)

  const pages: Array<PageChunk> = []
  console.warn(
    `reading ${totalContentPages} pages${total > totalContentPages ? ` (of ${total} total pages stopping at "${parsedToc.afterLastPageTocItem!.title}")` : ''}...`
  )

  do {
    const pageNav = await getPageNav()
    if (pageNav?.page === undefined) {
      break
    }
    if (pageNav.page > totalContentPages) {
      break
    }

    const index = pages.length

    const src = await page
      .locator(krRendererMainImageSelector)
      .getAttribute('src')

    const b = await page
      .locator(krRendererMainImageSelector)
      .screenshot({ type: 'png', scale: 'css' })

    const screenshotPath = path.join(
      pageScreenshotsDir,
      `${index}`.padStart(pagePadding, '0') +
        '-' +
        `${pageNav.page}`.padStart(pagePadding, '0') +
        '.png'
    )
    await fs.writeFile(screenshotPath, b)
    pages.push({
      index,
      page: pageNav.page,
      total: pageNav.total,
      screenshot: screenshotPath
    })

    console.warn(pages.at(-1))

    // Navigation is very spotty without this delay; I think it may be due to
    // the screenshot changing the DOM temporarily and not being stable yet.
    await delay(100)

    if (pageNav.page > totalContentPages) {
      break
    }

    let retries = 0
    let navigationSucceeded = false

    // Occasionally the next page button doesn't work, so ensure that the main
    // image src actually changes before continuing.
    do {
      try {
        // Navigate to the next page
        // await delay(100)
        if (retries % 10 === 0) {
          if (retries > 0) {
            console.warn('retrying...', {
              src,
              retries,
              ...pages.at(-1)
            })
          }

          // Click the next page button
          await page
            .locator('button#kr-chevron-right')
            .click({ timeout: 1000 })
        }
        // await delay(500)
      } catch (err: any) {
        // No next page to navigate to
        console.warn(
          'unable to navigate to next page; breaking...',
          err.message
        )
        break
      }

      const newSrc = await page
        .locator(krRendererMainImageSelector)
        .getAttribute('src')
      if (newSrc !== src) {
        navigationSucceeded = true
        break
      }

      await delay(100)

      ++retries
    } while (true)

    if (!navigationSucceeded) {
      break
    }
  } while (true)

  let retries = 0
  while ((!info || !meta) && retries < 20) {
    // wait up to 10 seconds
    await delay(500)
    retries++
  }

  if (!info || !meta) {
    page.removeListener('response', responseHandler)
    throw new Error(`Could not fetch book metadata for ASIN ${asin}`)
  }

  const result: BookMetadata = { info: info!, meta: meta!, toc, pages }
  await fs.writeFile(
    path.join(outDir, 'metadata.json'),
    JSON.stringify(result, null, 2)
  )
  console.log(JSON.stringify(result, null, 2))

  if (initialPageNav?.page !== undefined) {
    console.warn(`resetting back to initial page ${initialPageNav.page}...`)
    // Reset back to the initial page
    await goToPage(initialPageNav.page)
  }

  page.removeListener('response', responseHandler)
}

async function main() {
  const amazonEmail = getEnv('AMAZON_EMAIL')
  const amazonPassword = getEnv('AMAZON_PASSWORD')
  assert(amazonEmail, 'AMAZON_EMAIL is required')
  assert(amazonPassword, 'AMAZON_PASSWORD is required')

  const completedAsinsPath = path.join('out', 'completed_asins_extract.txt')
  let completedAsins = new Set<string>()
  try {
    const completedData = await fs.readFile(completedAsinsPath, 'utf-8')
    completedAsins = new Set(completedData.split('\n').map((s) => s.trim()))
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      throw err
    }
  }

  const csvData = await fs.readFile(path.join('input', 'ASIN.csv'), 'utf-8')
  const asins = csvData
    .split('\n')
    .slice(1) // Skip header
    .map((row) => row.trim())
    .filter((row) => row)

  if (!asins.length) {
    console.log('No ASINs to process.')
    return
  }

  console.log(`Starting book extraction for ${asins.length} ASINs...`)

  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: ['--hide-crash-restore-bubble'],
    ignoreDefaultArgs: ['--enable-automation']
  })
  const context = await browser.newContext({
    deviceScaleFactor: 2,
    viewport: { width: 1280, height: 720 }
  })
  const page = await context.newPage()

  // Login using the first ASIN
  const firstAsin = asins.find((asin) => !completedAsins.has(asin))
  if (!firstAsin) {
    console.log('All ASINs have already been processed.')
    await browser.close()
    return
  }

  const bookReaderUrl = `https://read.amazon.com/?asin=${firstAsin}`
  console.log(`\n---\nLogging in using ASIN: ${firstAsin}\n---`)

  await Promise.any([
    page.goto(bookReaderUrl, { timeout: 30_000 }),
    page.waitForURL('**/ap/signin', { timeout: 30_000 })
  ])

  if (/\/ap\/signin/g.test(new URL(page.url()).pathname)) {
    await page.locator('input[type="email"]').fill(amazonEmail)
    await page.locator('input[type="submit"]').click()

    await page.locator('input[type="password"]').fill(amazonPassword)
    await page.locator('input[type="submit"]').click()
  }

  // Wait for login to complete and we are at the book reader page
  try {
    await page.waitForURL(bookReaderUrl, { timeout: 30_000 })
  } catch (err) {
    console.error(
      'Login failed or took too long. Please check your credentials and internet connection.'
    )
    await browser.close()
    return
  }

  for (const asin of asins) {
    if (completedAsins.has(asin)) {
      console.log(`Skipping already processed ASIN: ${asin}`)
      continue
    }

    try {
      console.log(`\n---\nProcessing ASIN: ${asin}\n---`)
      await extractBook(page, asin)
      await fs.appendFile(completedAsinsPath, `${asin}\n`)
    } catch (err: any) {
      console.error(`Error processing ASIN ${asin}:`, err.message)
    }
  }

  await page.close()
  await context.close()
  await browser.close()
}

function parsePageNav(text: string | null): PageNav | undefined {
  {
    // Parse normal page locations
    const match = text?.match(/page\s+(\d+)\s+of\s+(\d+)/i)
    if (match) {
      const page = Number.parseInt(match?.[1]!)
      const total = Number.parseInt(match?.[2]!)
      if (Number.isNaN(page) || Number.isNaN(total)) {
        return undefined
      }

      return { page, total }
    }
  }

  {
    // Parse locations which are not part of the main book pages
    // (toc, copyright, title, etc)
    const match = text?.match(/location\s+(\d+)\s+of\s+(\d+)/i)
    if (match) {
      const location = Number.parseInt(match?.[1]!)
      const total = Number.parseInt(match?.[2]!)
      if (Number.isNaN(location) || Number.isNaN(total)) {
        return undefined
      }

      return { location, total }
    }
  }

  {
    // Parse locations which use roman numerals
    const match = text?.match(/page\s+([cdilmvx]+)\s+of\s+(\d+)/i)
    if (match) {
      const location = deromanize(match?.[1]!)
      const total = Number.parseInt(match?.[2]!)
      if (Number.isNaN(location) || Number.isNaN(total)) {
        return undefined
      }

      return { location, total }
    }
  }
}

function parseTocItems(tocItems: TocItem[]) {
  // Find the first page in the TOC which contains the main book content
  // (after the title, table of contents, copyright, etc)
  const firstPageTocItem = tocItems.find((item) => item.page !== undefined)
  assert(firstPageTocItem, 'Unable to find first valid page in TOC')

  // Try to find the first page in the TOC after the main book content
  // (e.g. acknowledgements, about the author, etc)
  const afterLastPageTocItem = tocItems.find((item) => {
    if (item.page === undefined) return false
    if (item === firstPageTocItem) return false

    const percentage = item.page / item.total
    if (percentage < 0.9) return false

    if (/acknowledgements/i.test(item.title)) return true
    if (/^discover more$/i.test(item.title)) return true
    if (/^extras$/i.test(item.title)) return true
    if (/about the author/i.test(item.title)) return true
    if (/meet the author/i.test(item.title)) return true
    if (/^also by /i.test(item.title)) return true
    if (/^copyright$/i.test(item.title)) return true
    if (/ teaser$/i.test(item.title)) return true
    if (/ preview$/i.test(item.title)) return true
    if (/^excerpt from/i.test(item.title)) return true
    if (/^cast of characters$/i.test(item.title)) return true
    if (/^timeline$/i.test(item.title)) return true
    if (/^other titles/i.test(item.title)) return true

    return false
  })

  return {
    firstPageTocItem,
    afterLastPageTocItem
  }
}

await main()