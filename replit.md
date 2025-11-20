# ProdyScan

## Overview
ProdyScan is a Flask-based web application that helps users find products online by analyzing product images. The app uses OCR (Optical Character Recognition) and optionally OpenAI's Vision API to extract product information from images and generate search queries for various e-commerce platforms.

**Current State**: Successfully imported and configured for Replit environment. The application is fully functional and ready for use.

**Date**: November 20, 2025

## Features
- Image analysis using Tesseract OCR for text extraction
- Optional OpenAI Vision API integration for enhanced product description
- Support for multiple e-commerce platforms (Jumia, Amazon, AliExpress, eBay, Cdiscount, Alibaba)
- Country-specific search targeting (Ivory Coast, Senegal, Morocco, France, etc.)
- Custom shop search capability
- Search history with localStorage
- Image caching to avoid redundant API calls

## Project Architecture

### Tech Stack
- **Backend**: Flask (Python 3.11)
- **Image Processing**: Pillow (PIL)
- **OCR**: Tesseract + pytesseract
- **AI (Optional)**: OpenAI API (gpt-4o-mini)
- **Frontend**: Vanilla JavaScript, HTML, CSS

### Directory Structure
```
.
├── app.py                 # Main Flask application
├── requirements.txt       # Python dependencies
├── static/               # Static assets
│   ├── app.js           # Frontend JavaScript
│   └── style.css        # Styles
├── templates/           # Flask templates
│   └── index.html       # Main UI template
├── uploads/             # Image uploads directory
├── cache.json           # Search results cache
├── data/                # Product data (unused in current setup)
├── engines/             # Embedding engines (unused in current setup)
└── scripts/             # Build scripts (unused in current setup)
```

## Recent Changes (November 20, 2025)

### Replit Environment Setup
1. Installed Python 3.11 and Tesseract OCR system dependency
2. Installed all required Python packages (flask, pillow, pytesseract, openai, urllib3, gunicorn)
3. Fixed duplicate `ai_describe_image` function definition
4. Updated default port from 10000 to 5000 for Replit compatibility
5. Configured Flask workflow to run on port 5000 with webview output
6. Created Python-specific .gitignore file
7. Configured autoscale deployment using Gunicorn for production
8. Added Gunicorn as production WSGI server (development uses Flask's debug server)

## Configuration

### Environment Variables
- `OPENAI_API_KEY` (optional): OpenAI API key for Vision API features
- `PORT` (default: 5000): Port for the Flask server

### Running the Application
The application automatically starts via the configured workflow:
```bash
python app.py
```

The Flask server runs on `0.0.0.0:5000` and is accessible through the Replit webview.

## How It Works

1. **Image Upload**: User uploads or captures a product image
2. **Image Processing**: Image is preprocessed (resized, converted to JPEG)
3. **Analysis**:
   - If OpenAI API key is available: Uses GPT-4o-mini to describe the product
   - Tesseract OCR extracts text from the image
   - Results are combined for optimal search query
4. **Search URL Generation**: Builds platform-specific search URL based on:
   - Selected e-commerce platform (or custom shop)
   - Target country
   - Generated search query
5. **Caching**: Results are cached using MD5 hash of image + shop + country
6. **History**: Search history stored in browser localStorage

## Dependencies

### System Dependencies
- Tesseract OCR

### Python Packages
- flask - Web framework
- pillow - Image processing
- pytesseract - Python wrapper for Tesseract OCR
- openai - OpenAI API client (optional)
- urllib3 - HTTP library
- gunicorn - Production WSGI server

## User Preferences
None specified yet.

## Notes
- The `data/`, `engines/`, and `scripts/` directories contain code for product embedding and indexing features that are not currently used by the main application
- OpenAI Vision API is optional; the app works with OCR only
- Image caching helps reduce API costs and improve performance
- The application uses Flask's development server; production deployment uses autoscale configuration
