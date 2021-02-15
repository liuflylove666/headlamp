GO111MODULE=on
export GO111MODULE

SERVER_EXE_EXT ?=
DOCKER_CMD ?= docker
DOCKER_REPO ?= docker.io/kinvolk
DOCKER_IMAGE_NAME ?= headlamp
DOCKER_IMAGE_VERSION ?= $(shell git describe --tags --always --dirty)
DOCKER_IMAGE_BASE ?= alpine:3.11.3

ifeq ($(OS), Windows_NT)
	SERVER_EXE_EXT = .exe
endif
all: backend frontend

tools/golangci-lint: backend/go.mod backend/go.sum
	cd backend && go build -o ./tools/golangci-lint github.com/golangci/golangci-lint/cmd/golangci-lint

backend-lint: tools/golangci-lint
	cd backend && ./tools/golangci-lint run

.PHONY: app
app-build:
	cd app && npm install && npm run build
app: app-build
	cd app && npm run package -- --win --linux --mac
app-win: app-build
	cd app && npm run package -- --win
app-linux: app-build
	cd app && npm run package -- --linux
app-mac: app-build
	cd app && npm run package -- --mac

.PHONY: backend
backend:
	cd backend && go build -o ./server${SERVER_EXE_EXT} ./cmd

frontend-install:
	cd frontend && npm install

.PHONY: frontend
frontend: frontend-install
	cd frontend && npm run build

run-backend:
	./backend/server -dev

run-frontend:
	cd frontend && npm start

frontend-lint:
	cd frontend && npm run lint -- --max-warnings 0

frontend-fixlint:
	cd frontend && npm run lint -- --fix

image:
	$(DOCKER_CMD) build \
	--build-arg IMAGE_BASE=$(DOCKER_IMAGE_BASE) \
	-t $(DOCKER_REPO)/$(DOCKER_IMAGE_NAME):$(DOCKER_IMAGE_VERSION) -f \
	Dockerfile \
	.
