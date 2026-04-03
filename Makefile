.PHONY: install dev start typecheck docker-build docker-up docker-down

install:
	bun install

dev:
	bun run --watch src/index.ts

start:
	bun run src/index.ts

typecheck:
	bun run tsc --noEmit

docker-build:
	docker build -t splitcount .

docker-up:
	docker compose up --build -d

docker-down:
	docker compose down
