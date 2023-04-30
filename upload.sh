#!/bin/bash

rsync -a --exclude "node_modules" . root@app-1.instantchatbot.net:/home/app/

