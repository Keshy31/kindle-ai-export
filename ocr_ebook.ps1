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

    $maxJobs = 1 # Adjust based on CPU cores

    $jobScript = {
        param($pngFile, $outputDir, $pageNum, $index)
        $tempTxt = "$outputDir\temp_page_$index.txt"
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

    $results = @()
    $totalPages = $pages.Count
    $started = 0
    $completed = 0

    $jobs = @{}
    foreach ($page in $pages) {
        $pageNum = $page.page
        $index = $page.index
        if ($pageNum -eq $null) { continue }  # Skip invalid
        $pngFile = $page.screenshot

        # Throttle: Wait until a slot is available
        while ((Get-Job -State Running).Count -ge $maxJobs) {
            $runningJobs = Get-Job -State Running
            $finishedJob = Wait-Job -Job $runningJobs -Any
            $result = Receive-Job $finishedJob
            $results += $result
            Remove-Job $finishedJob
            $completed++
            # Log with correct details (from hashtable)
            $jobDetails = $jobs[$finishedJob.Id]
            Write-Host "Completed OCR job $completed of $totalPages (index $($jobDetails.Index), page $($jobDetails.PageNum))"
        }

        $started++
        Write-Host "Started OCR job $started of $totalPages (index $index, page $pageNum)"
        $job = Start-ThreadJob -ScriptBlock $jobScript -ArgumentList $pngFile, $outputDir, $pageNum, $index
        # Store details for later logging
        $jobs[$job.Id] = @{ Index = $index; PageNum = $pageNum }
        Start-Sleep -Milliseconds 50  # Small delay to allow job state to update
    }

    # Wait for all remaining and collect
    Write-Host "Waiting for remaining jobs to complete..."
    $remainingJobs = Get-Job
    foreach ($job in $remainingJobs) {
        $result = Receive-Job $job -Wait
        $results += $result
        Remove-Job $job
        $completed++
        $jobDetails = $jobs[$job.Id]
        Write-Host "Completed OCR job $completed of $totalPages (index $($jobDetails.Index), page $($jobDetails.PageNum))"
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