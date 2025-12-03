#!/bin/bash

# samramansang run script (simple execution)

# Change to the directory where the script is located
cd "$(dirname "$0")"

# Check if .venv exists
if [ -d ".venv" ]; then
    source .venv/bin/activate
    
    # Check if requirements.txt packages are installed
    if python -c "import flask" 2>/dev/null; then
        echo "Running app.py..."
        python app.py
    else
        echo "Dependencies are not installed. Installing dependencies..."
        pip install -r requirements.txt
        echo "Running app.py..."
        python app.py
    fi
else
    echo "Virtual environment not found. Please run ./init.sh first."
    exit 1
fi

