# Parameters (customize these)
$asin = "test"  # Change per book
$baseDir = "out\$asin"
$inputDir = "$baseDir\pages"
$outputDir = $baseDir
$metadataFile = "$baseDir\metadata.json"
$outputFile = "$outputDir\book.md"

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

$maxJobs = 4  # Adjust based on CPU cores

$jobScript = {
    param($pngFile, $outputDir, $pageNum, $index)
    $tempTxt = "$outputDir\temp_page_$pageNum.txt"
    tesseract $pngFile $tempTxt.Replace('.txt', '') -l eng --psm 3
    if (Test-Path $tempTxt) {
        $pageText = Get-Content $tempTxt -Raw
        [PSCustomObject]@{ Index = $index; PageNum = $pageNum; Text = $pageText }
        Remove-Item $tempTxt
    } else {
        Write-Warning "OCR failed for $pngFile"
        [PSCustomObject]@{ Index = $index; PageNum = $pageNum; Text = "" }
    }
}

$jobs = @()
$results = @()

foreach ($page in $pages) {
    $pageNum = $page.page
    $index = $page.index
    if ($pageNum -eq $null) { continue }  # Skip invalid
    $pngFile = $page.screenshot

    # Launch job
    while ((Get-Job -State Running).Count -ge $maxJobs) {
        $finishedJobs = Get-Job -State Completed
        foreach ($job in $finishedJobs) {
            $result = Receive-Job $job
            $results += $result
            Remove-Job $job
        }
        Start-Sleep -Milliseconds 100
    }

    $job = Start-Job -ScriptBlock $jobScript -ArgumentList $pngFile, $outputDir, $pageNum, $index
    $jobs += $job
}

# Wait for all remaining jobs and collect results
Get-Job | Wait-Job | ForEach-Object {
    $result = Receive-Job $_
    $results += $result
    Remove-Job $_
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