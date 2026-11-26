// Vite: bundles the pdf.js worker and hands its URL to pdf.js. Import this file once (PaperImport does).
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
