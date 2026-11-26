# Xray (VLESS + WebSocket) for Railway.
# Railway terminates TLS at the edge and forwards plain HTTP to this service,
# so Xray only needs to listen on $PORT for plain WebSocket. No secrets in
# this image: UUID and WS_PATH come from Railway environment variables.
FROM alpine:latest
RUN apk add --no-cache curl unzip ca-certificates
WORKDIR /app
ARG XRAY_VERSION=v26.11.9
RUN curl -L -o /tmp/xray.zip "https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/Xray-linux-64.zip" \
    && unzip /tmp/xray.zip -d /usr/local/bin/ \
    && chmod +x /usr/local/bin/xray \
    && rm /tmp/xray.zip
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
CMD ["/app/entrypoint.sh"]
