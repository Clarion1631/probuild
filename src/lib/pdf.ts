import puppeteer from 'puppeteer';

export async function generateEstimatePdf(estimateId: string): Promise<Buffer> {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    // Append ?print=true to trigger print-specific CSS or logic if needed
    const url = `${baseUrl}/portal/estimates/${estimateId}?print=true`;

    // Launch a headless browser
    const browser = await puppeteer.launch({
        headless: true, // using true for new headless mode
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        const page = await browser.newPage();

        // Wait until there are no more than 0 network connections for at least 500ms
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

        // Ensure the page renders fully before taking snapshot
        await page.evaluateHandle('document.fonts.ready');

        // Generate the PDF
        const pdfBuffer = await page.pdf({
            format: 'Letter',
            printBackground: true,
            margin: { top: '0.4in', right: '0.4in', bottom: '0.4in', left: '0.4in' }
        });

        return Buffer.from(pdfBuffer);
    } finally {
        await browser.close();
    }
}
