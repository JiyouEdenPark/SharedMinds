#!/bin/bash

# samramansang initialization and run script

# Change to the directory where the script is located
cd "$(dirname "$0")"

# Check if .venv exists
if [ -d ".venv" ]; then
    echo ".venv already exists."
    
    # Activate virtual environment
    source .venv/bin/activate
    
    # Check if requirements.txt packages are installed
    # Check by importing a specific package
    if python -c "import flask" 2>/dev/null; then
        echo "Dependencies are already installed."
        echo "Running app.py..."
        python app.py
    else
        echo "Installing dependencies..."
        pip install -r requirements.txt
        echo "Running app.py..."
        python app.py
    fi
else
    echo "Creating .venv..."
    python3 -m venv .venv
    
    echo "Activating virtual environment..."
    source .venv/bin/activate
    
    echo "Installing dependencies..."
    pip install --upgrade pip
    pip install -r requirements.txt
    
    echo "Running app.py..."
    python app.py
fi

