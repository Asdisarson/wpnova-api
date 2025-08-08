import os
import logging
import undetected_chromedriver as uc
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, WebDriverException
import time
from datetime import datetime

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Web Scraper API", version="1.0.0")

class WebScraper:
    def __init__(self):
        self.driver = None
        self.initialized = False
    
    def initialize_scraper(self):
        """Initialize the Chrome driver with proper configuration"""
        try:
            # Configure Chrome options
            options = uc.ChromeOptions()
            options.add_argument('--no-sandbox')
            options.add_argument('--disable-setuid-sandbox')
            options.add_argument('--disable-dev-shm-usage')
            options.add_argument('--disable-gpu')
            options.add_argument('--headless')
            options.add_argument('--disable-web-security')
            options.add_argument('--allow-running-insecure-content')
            
            # Initialize the driver
            self.driver = uc.Chrome(options=options)
            self.initialized = True
            logger.info("FastAPI server is running and ready to accept requests.")
            return True
        except Exception as e:
            logger.error(f"Failed to initialize scraper: {e}")
            self.initialized = False
            return False
    
    def cleanup(self):
        """Clean up the driver"""
        if self.driver:
            try:
                self.driver.quit()
            except Exception as e:
                logger.error(f"Error during cleanup: {e}")
            finally:
                self.driver = None
                self.initialized = False

# Global scraper instance
scraper = WebScraper()

@app.on_event("startup")
async def startup_event():
    """Initialize the scraper on startup"""
    scraper.initialize_scraper()

@app.on_event("shutdown")
async def shutdown_event():
    """Clean up the scraper on shutdown"""
    scraper.cleanup()

@app.get("/")
async def root():
    """Health check endpoint"""
    return {"message": "Web Scraper API is running", "status": "healthy"}

@app.get("/refresh")
async def refresh_data(date: str = None):
    """Refresh data for a specific date"""
    if not scraper.initialized:
        raise HTTPException(status_code=503, detail="Scraper not initialized")
    
    try:
        # Parse the date
        if date:
            target_date = datetime.strptime(date, "%Y-%m-%d")
        else:
            target_date = datetime.now()
        
        task_id = f"scrape_{target_date.strftime('%Y-%m-%d')}_{int(time.time() * 1000)}"
        logger.info(f"Starting scrape task {task_id} for date {target_date}")
        
        # Your scraping logic here
        # This is where you would implement the actual scraping functionality
        
        return {
            "message": "Scraping completed",
            "task_id": task_id,
            "date": target_date.strftime("%Y-%m-%d"),
            "status": "success"
        }
        
    except Exception as e:
        logger.error(f"Scraping failed for task {task_id}: {e}")
        raise HTTPException(status_code=500, detail=f"Scraping failed: {str(e)}")

@app.get("/health")
async def health_check():
    """Health check with scraper status"""
    return {
        "status": "healthy",
        "scraper_initialized": scraper.initialized,
        "timestamp": datetime.now().isoformat()
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
