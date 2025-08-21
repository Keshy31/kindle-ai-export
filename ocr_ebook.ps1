# Read ASINs from CSV
$asins = Import-Csv -Path "input\ASIN.csv"

# Completed ASINs tracking
$completedAsinsFile = "out\completed_asins_ocr.txt"
$completedAsins = if (Test-Path $completedAsinsFile) {
    Get-Content $completedAsinsFile
} else {
    @()
}

foreach ($item in $asins) {
    $asin = $item.ASIN
    if ($completedAsins -contains $asin) {
        Write-Host "Skipping already processed ASIN: $asin"
        continue
    }

    Write-Host "---"
    Write-Host "Processing ASIN: $asin"
    Write-Host "---"

    # Parameters
    $baseDir = "out\$asin"
    $inputDir = "$baseDir\pages"
    $outputDir = $baseDir
    $metadataFile = "$baseDir\metadata.json"
    $outputFile = "$outputDir\$asin.md"

    # Ensure directories exist
    New-Item -ItemType Directory -Force -Path $outputDir

    $useMetadata = Test-Path $metadataFile

    if ($useMetadata) {
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
    } else {
        $bookTitle = "Untitled Book"
        $authors = "Unknown Author"
        $tocHash = @{}
        # Get all PNG files, sort by filename (assumes pattern like 0000-0001.png)
        $pages = Get-ChildItem -Path $inputDir -Filter *.png | Sort-Object Name | ForEach-Object {
            $fileBaseName = $_.BaseName
            $indexFromFile = if ($fileBaseName -match '^(\d+)-') { [int]$Matches[1] } else { 0 }
            $pageNumFromFile = if ($fileBaseName -match '-(\d+)') { [int]$Matches[1] } else { 0 }
            [PSCustomObject]@{
                index = $indexFromFile
                page = $pageNumFromFile
                screenshot = $_.FullName
            }
        }
    }

    # Initialize output content
    $outputContent = "# $bookTitle`n`n**Author(s):** $authors`n`n---`n`n"

    $results = @()
    $totalPages = $pages.Count
    $currentPage = 0
    foreach ($page in $pages) {
        $currentPage++
        $pageNum = $page.page
        $index = $page.index
        if ($pageNum -eq $null) { continue } # Skip invalid
        $pngFile = $page.screenshot

        Write-Host "Processing page $currentPage of $totalPages (index $index, page $pageNum)"

        $outputFileBase = Join-Path -Path $outputDir -ChildPath "temp_page_$index"
        $tempTxtFile = "$outputFileBase.txt"

        # Run Tesseract OCR
        tesseract $pngFile $outputFileBase -l eng --psm 3

        if (Test-Path $tempTxtFile) {
            $pageText = Get-Content $tempTxtFile -Raw
            $results += [PSCustomObject]@{ Index = $index; PageNum = $pageNum; Text = $pageText }
            Remove-Item $tempTxtFile
        } else {
            Write-Warning "OCR failed for $pngFile"
            $results += [PSCustomObject]@{ Index = $index; PageNum = $pageNum; Text = "" }
        }
    }

    # Sort results by index and build output
    $results = $results | Sort-Object Index
    $previousPage = 0

    foreach ($result in $results) {
        $pageNum = $result.PageNum
        if ($pageNum -ne $previousPage) {
            if ($useMetadata -and $tocHash.ContainsKey($pageNum)) {
                $chapterTitle = $tocHash[$pageNum]
                $outputContent += "`n# $chapterTitle`n`n"
            }
            $outputContent += "`n[Page $pageNum]`n`n"
            $previousPage = $pageNum
        }
        $pageText = $result.Text
        if ($pageText) {
            $outputContent += "$pageText`n"
        }
    }

    # Write to MD file
    $outputContent | Out-File -FilePath $outputFile -Encoding utf8
    Write-Output "Combined Markdown saved to $outputFile"

    # Mark ASIN as complete
    Add-Content -Path $completedAsinsFile -Value $asin
}