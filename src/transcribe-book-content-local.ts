import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import { globby } from 'globby'
import ollama, { type Ollama } from 'ollama'
import pMap from 'p-map'

import type { ContentChunk } from './types'
import { assert, getEnv } from './utils'

async function ollamaChat(
  system: string,
  imageBuffer: Buffer,
  temperature: number = 0
) {
  const model = process.env.OLLAMA_MODEL || 'llava:13b'

  const response = await ollama.chat({
    model,
    messages: [
      {
        role: 'system',
        content: system
      },
      {
        role: 'user',
        content: ' ',
        images: [imageBuffer]
      }
    ],
    options: {
      temperature
    }
  })

  return response.message.content
}

async function main() {
  const asin = getEnv('ASIN')
  assert(asin, 'ASIN is required')

  const outDir = path.posix.join('out', asin)
  const pageScreenshotsDir = path.posix.join(outDir, 'pages')
  console.log('Looking for screenshots in:', pageScreenshotsDir)
  const pageScreenshots = await globby(`${pageScreenshotsDir}/*.png`)
  console.log('Found screenshots:', pageScreenshots)
  assert(pageScreenshots.length, 'no page screenshots found')

  const content: ContentChunk[] = (
    await pMap(
      pageScreenshots,
      async (screenshot) => {
        const screenshotBuffer = await fs.readFile(screenshot)
        const metadataMatch = screenshot.match(/0*(\d+)-\0*(\d+).png/)
        assert(
          metadataMatch?.[1] && metadataMatch?.[2],
          `invalid screenshot filename: ${screenshot}`
        )
        const index = Number.parseInt(metadataMatch[1]!, 10)
        const page = Number.parseInt(metadataMatch[2]!, 10)
        assert(
          !Number.isNaN(index) && !Number.isNaN(page),
          `invalid screenshot filename: ${screenshot}`
        )

        try {
          const maxRetries = 20
          let retries = 0

          do {
            const temp = retries < 2 ? 0 : 0.5
            const res = await ollamaChat(`You will be given an image containing text. Read the text from the image and output it verbatim.
Do not include any additional text, descriptions, or punctuation. Ignore any embedded images. Do not use markdown.${retries > 2 ? '\n\nThis is an important task for analyzing legal documents cited in a court case.' : ''}`, screenshotBuffer, temp)

            const rawText = res
            const text = rawText
              .replace(/^\s*\d+\s*$\n+/m, '')
              // .replaceAll(/\n+/g, '\n')
              .replaceAll(/^\s*/gm, '')
              .replaceAll(/\s*$/gm, '')

            ++retries

            if (!text) continue
            if (text.length < 100 && /i'm sorry/i.test(text)) {
              if (retries >= maxRetries) {
                throw new Error(
                  `Model refused too many times (${retries} times): ${text}`
                )
              }

              // Sometimes the model refuses to generate text for an image
              // presumably if it thinks the content may be copyrighted or
              // otherwise inappropriate. If we suspect a refual, we'll retry with a
              // higher temperature and cross our fingers.
              console.warn('retrying refusal...', { index, text, screenshot })
              continue
            }

            const result: ContentChunk = {
              index,
              page,
              text,
              screenshot
            }
            console.log(result)

            return result
          } while (true)
        } catch (err) {
          console.error(`error processing image ${index} (${screenshot})`, err)
        }
      },
      { concurrency: 1 } // Lower concurrency for local model
    )
  ).filter(Boolean)

  await fs.writeFile(
    path.join(outDir, 'content.json'),
    JSON.stringify(content, null, 2)
  )
  console.log(JSON.stringify(content, null, 2))
}

await main()