# Parameters (customize these)
$asin = "test"  # From your example; change per book
$baseDir = "out\$asin"
$inputDir = "$baseDir\pages"
$outputDir = $baseDir
$metadataFile = "$baseDir\metadata.json"
$outputFile = "$outputDir\book.md"

# Ensure directories exist
New-Item -ItemType Directory -Force -Path $outputDir

# Parse metadata.json
$metadata = Get-Content $metadataFile | ConvertFrom-Json

# Extract book info
$bookTitle = $metadata.meta.title
$authors = $metadata.meta.authorList -join ", "  # Handle array

# TOC as hashtable for quick lookup: page -> title
$tocHash = @{}
$metadata.toc | ForEach-Object {
    if ($_.page -ne $null) {
        $tocHash[$_.page] = $_.title
    }
}

# Get pages array and sort by index (to handle order)
$pages = $metadata.pages | Sort-Object -Property index

# Initialize output content
$outputContent = "# $bookTitle`n`n**Author(s):** $authors`n`n---`n`n"

# Track last page to skip duplicates
$lastPage = 0

foreach ($page in $pages) {
    $pageNum = $page.page
    if ($pageNum -eq $null -or $pageNum -le $lastPage) { continue }  # Skip invalid or duplicates

    $pngFile = $page.screenshot  # Full path from metadata

    # Check for TOC header at this page
    if ($tocHash.ContainsKey($pageNum)) {
        $chapterTitle = $tocHash[$pageNum]
        $outputContent += "`n# $chapterTitle`n`n"
    }

    # OCR the page
    $tempTxt = "$outputDir\temp_page_$pageNum.txt"
    tesseract $pngFile $tempTxt.Replace('.txt', '') -l eng --psm 3
    $ocrText = Get-Content $tempTxt -Raw
    Write-Output $ocrText

    # Append OCR text with page marker
    if (Test-Path $tempTxt) {
        $pageText = Get-Content $tempTxt -Raw
        $outputContent += "`n[Page $pageNum]`n`n$pageText`n"
        Remove-Item $tempTxt  # Clean up
    } else {
        Write-Warning "OCR failed for $pngFile"
    }

    $lastPage = $pageNum
}

# Write to MD file
$outputContent | Out-File -FilePath $outputFile -Encoding utf8
Write-Output "Combined Markdown saved to $outputFile"
