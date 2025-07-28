# Kindle AI Export: Codebase Explanation

## Overview

This project is a Node.js command-line tool designed to export any Kindle book you own into various formats, including text, PDF, EPUB, or a custom, AI-narrated audiobook. It works by automating the Kindle Cloud Reader to extract book content, which can then be repurposed.

## How it Works

The process is orchestrated by the main script, `src/extract-kindle-book.ts`, and involves several key steps:

### 1. Initialization and Configuration

- The script loads environment variables from a `.env` file, requiring your `AMAZON_EMAIL`, `AMAZON_PASSWORD`, and the book's `ASIN` (Amazon Standard Identification Number).
- It creates an `out/[ASIN]` directory to store all extracted data, including metadata and page images.

### 2. Browser Automation with Playwright

- It uses `playwright` to launch a persistent Chrome browser instance, allowing it to maintain your Amazon login session across runs.
- The script navigates directly to the Kindle Cloud Reader URL for the specified book.

### 3. Authentication and Book Access

- The tool automates the login process. If your account has Two-Factor Authentication (2FA) enabled, it will prompt you in the terminal to enter the code.
- Once authenticated, it accesses the book's content within the web reader.

### 4. Data Extraction

- **Metadata**: The script intercepts network requests to Amazon's servers to capture the book's metadata, including title, author, and table of contents.
- **Content**: The core extraction mechanism involves programmatically "turning the pages" by simulating clicks on the next page button. For each page, it saves a high-quality screenshot.

### 5. Content Transcription (Image-to-Text)

- The `src/transcribe-book-content.ts` script takes the page screenshots and uses a vision-capable Large Language Model (vLLM) to perform Optical Character Recognition (OCR), converting the images into text.
- By default, it uses OpenAI's **`gpt-4o`** or **`gpt-4o-mini`** models. Alternatively, you can configure it to use a local vLLM running on [Ollama](https://ollama.com/) by setting `VLLM_PROVIDER=ollama` and specifying a model with `OLLAMA_MODEL` (e.g., `llava:7b`).
- The extracted text content is saved to `out/[ASIN]/content.json`.

### 6. Output Generation

- With the book's content available as structured text, other scripts can convert it into different formats:
  - `export-book-pdf.ts`: Creates a PDF from the page screenshots.
  - `export-book-markdown.ts`: Generates a clean Markdown file.
  - `export-book-audio.ts`: Uses Text-to-Speech (TTS) APIs from **OpenAI** or **Unreal Speech** to create an AI-narrated audiobook.

## Core Scripts

- `src/extract-kindle-book.ts`: Main script to log in and extract page screenshots and metadata.
- `src/transcribe-book-content.ts`: Converts page images to text using either OpenAI or a local Ollama instance.
- `src/export-book-pdf.ts`: Compiles screenshots into a PDF.
- `src/export-book-markdown.ts`: Converts transcribed text into Markdown.
- `src/export-book-audio.ts`: Converts transcribed text into an audiobook.

## Important Notes

### Disclaimer

This project is for **personal and educational use only**. It is not endorsed by Amazon. Please do not share the exported content publicly and ensure that authors and artists are fairly compensated for their work.

### Accuracy and Limitations

The accuracy of the text transcription is very high but not perfect. Occasional errors, especially with whitespace, may occur. The process does not currently handle embedded images within the book pages.

### Costs

Transcribing the book content incurs costs from the AI provider (e.g., OpenAI). Using `gpt-4o-mini` is significantly cheaper than `gpt-4o`.
Using a local Ollama instance can eliminate these costs, but requires a local setup with a compatible model.

## Summary

In essence, this codebase uses a combination of web scraping, browser automation, and API interactions to liberate your Kindle books from the confines of the Kindle ecosystem. It's a powerful tool for anyone who wants to have more control over their digital library, allowing them to create backups, read on different devices, or even listen to their books as audiobooks.