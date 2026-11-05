FROM python:3.13-slim

WORKDIR /app

COPY services/panel/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY services/panel/app ./app

CMD ["uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "5231"]

