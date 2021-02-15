/*
 * This module was originally taken from the K8dash project before modifications.
 *
 * K8dash is licensed under Apache License 2.0.
 *
 * Copyright © 2020 Eric Herbrandson
 * Copyright © 2020 Kinvolk GmbH
 */

import { getAppUrl } from '../../helpers';
import { getToken, logout } from '../auth';
import { getCluster } from '../util';
import { ResourceClasses } from '.';
import { KubeMetrics, KubeObjectClass, KubeObjectInterface } from './cluster';

const BASE_HTTP_URL = getAppUrl();
const BASE_WS_URL = BASE_HTTP_URL.replace('http', 'ws');
const CLUSTERS_PREFIX = 'clusters';
const JSON_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' };
const DEFAULT_TIMEOUT = 2 * 60 * 1000; // ms

interface RequestParams {
  timeout?: number; // ms
  [prop: string]: any;
}

export async function request(
  path: string,
  params: RequestParams = {},
  autoLogoutOnAuthError: boolean = true,
  useCluster: boolean = true
) {
  interface RequestHeaders {
    Authorization?: string;
    [otherHeader: string]: any;
  }

  const { timeout = DEFAULT_TIMEOUT, ...otherParams } = params;
  const opts: { headers: RequestHeaders } = Object.assign({ headers: {} }, otherParams);

  // @todo: This is a temporary way of getting the current cluster. We should improve it later.
  const cluster = getCluster();

  let fullPath = path;
  if (useCluster && cluster) {
    const token = getToken(cluster);
    if (!!token) {
      opts.headers.Authorization = `Bearer ${token}`;
    }

    fullPath = combinePath(`/${CLUSTERS_PREFIX}/${cluster}`, path);
  }

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  const url = combinePath(BASE_HTTP_URL, fullPath);
  const requestData = { signal: controller.signal, ...opts };
  let response: Response = new Response(undefined, { status: 502, statusText: 'Unreachable' });
  try {
    response = await fetch(url, requestData);
  } catch (err) {
    // AbortController sets the error code as 20
    if (err.code === 20) {
      response = new Response(undefined, { status: 408, statusText: 'Request timed-out' });
    }
  } finally {
    clearTimeout(id);
  }

  if (!response.ok) {
    const { status, statusText } = response;
    if (autoLogoutOnAuthError && status === 401 && opts.headers.Authorization) {
      console.error('Logging out due to auth error', { status, statusText, path });
      logout();
    }

    let message = statusText;
    try {
      const json = await response.json();
      message += ` - ${json.message}`;
    } catch (err) {
      console.error(
        'Unable to parse error json at url:',
        url,
        { err },
        'with request data:',
        requestData
      );
    }

    const error: Error & { status?: number } = new Error(message);
    error.status = status;
    throw error;
  }

  return response.json();
}

export type StreamResultsCb = (...args: any[]) => void;
export type StreamErrCb = (err: Error) => void;

export function apiFactory(group: string, version: string, resource: string) {
  const apiRoot = getApiRoot(group, version);
  const url = `${apiRoot}/${resource}`;
  return {
    resource: { group, resource },
    list: (cb: StreamResultsCb, errCb: StreamErrCb) => streamResults(url, cb, errCb),
    get: (name: string, cb: StreamResultsCb, errCb: StreamErrCb) =>
      streamResult(url, name, cb, errCb),
    post: (body: KubeObjectInterface) => post(url, body),
    put: (body: KubeObjectInterface) => put(`${url}/${body.metadata.name}`, body),
    delete: (name: string) => remove(`${url}/${name}`),
    isNamespaced: false,
  };
}

export function apiFactoryWithNamespace(
  group: string,
  version: string,
  resource: string,
  includeScale: boolean = false
) {
  const apiRoot = getApiRoot(group, version);
  const results: {
    resource: {
      group: string;
      resource: string;
    };
    [other: string]: any;
  } = {
    resource: { group, resource },
    list: (namespace: string, cb: StreamResultsCb, errCb: StreamErrCb) =>
      streamResults(url(namespace), cb, errCb),
    get: (namespace: string, name: string, cb: StreamResultsCb, errCb: StreamErrCb) =>
      streamResult(url(namespace), name, cb, errCb),
    post: (body: KubeObjectInterface) => post(url(body.metadata.namespace as string), body),
    put: (body: KubeObjectInterface) =>
      put(`${url(body.metadata.namespace as string)}/${body.metadata.name}`, body),
    delete: (namespace: string, name: string) => remove(`${url(namespace)}/${name}`),
    isNamespaced: true,
  };

  if (includeScale) {
    results.scale = apiScaleFactory(apiRoot, resource);
  }

  return results;

  function url(namespace: string) {
    return namespace ? `${apiRoot}/namespaces/${namespace}/${resource}` : `${apiRoot}/${resource}`;
  }
}

function getApiRoot(group: string, version: string) {
  return group ? `/apis/${group}/${version}` : `api/${version}`;
}

function apiScaleFactory(apiRoot: string, resource: string) {
  return {
    get: (namespace: string, name: string) => request(url(namespace, name)),
    put: (body: KubeObjectInterface) =>
      put(url(body.metadata.namespace as string, body.metadata.name), body),
  };

  function url(namespace: string, name: string) {
    return `${apiRoot}/namespaces/${namespace}/${resource}/${name}/scale`;
  }
}

export function post(
  url: string,
  json: JSON | object | KubeObjectInterface,
  autoLogoutOnAuthError = true,
  requestOptions = {}
) {
  const body = JSON.stringify(json);
  const opts = { method: 'POST', body, headers: JSON_HEADERS, ...requestOptions };
  return request(url, opts, autoLogoutOnAuthError);
}

export function put(
  url: string,
  json: KubeObjectInterface,
  autoLogoutOnAuthError = true,
  requestOptions = {}
) {
  const body = JSON.stringify(json);
  const opts = { method: 'PUT', body, headers: JSON_HEADERS, ...requestOptions };
  return request(url, opts, autoLogoutOnAuthError);
}

export function remove(url: string, requestOptions = {}) {
  const opts = { method: 'DELETE', headers: JSON_HEADERS, ...requestOptions };
  return request(url, opts);
}

export async function streamResult(
  url: string,
  name: string,
  cb: StreamResultsCb,
  errCb: StreamErrCb
) {
  let isCancelled = false;
  let socket: ReturnType<typeof stream>;
  run();

  return cancel;

  async function run() {
    try {
      const item = await request(`${url}/${name}`);

      if (isCancelled) return;
      cb(item);

      const fieldSelector = encodeURIComponent(`metadata.name=${name}`);
      const watchUrl = `${url}?watch=1&fieldSelector=${fieldSelector}`;

      socket = stream(watchUrl, x => cb(x.object), { isJson: true });
    } catch (err) {
      console.error('Error in api request', { err, url });
      if (errCb) errCb(err);
    }
  }

  function cancel() {
    if (isCancelled) return;
    isCancelled = true;

    if (socket) socket.cancel();
  }
}

export async function streamResults(url: string, cb: StreamResultsCb, errCb: StreamErrCb) {
  const results: {
    [uid: string]: KubeObjectInterface;
  } = {};
  let isCancelled = false;
  let socket: ReturnType<typeof stream>;
  run();

  return cancel;

  async function run() {
    try {
      const { kind, items, metadata } = await request(url);

      if (isCancelled) return;

      add(items, kind);

      const watchUrl = `${url}?watch=1&resourceVersion=${metadata.resourceVersion}`;
      socket = stream(watchUrl, update, { isJson: true });
    } catch (err) {
      console.error('Error in api request', { err, url });
      if (errCb) errCb(err);
    }
  }

  function cancel() {
    if (isCancelled) return;
    isCancelled = true;

    if (socket) socket.cancel();
  }

  function add(items: KubeObjectInterface[], kind: string) {
    const fixedKind = kind.slice(0, -4); // Trim off the word "List" from the end of the string
    for (const item of items) {
      item.kind = fixedKind;
      results[item.metadata.uid] = item;
    }

    push();
  }

  function update({
    type,
    object,
  }: {
    type: 'ADDED' | 'MODIFIED' | 'DELETED' | 'ERROR';
    object: KubeObjectInterface;
  }) {
    object.actionType = type; // eslint-disable-line no-param-reassign

    switch (type) {
      case 'ADDED':
        results[object.metadata.uid] = object;
        break;
      case 'MODIFIED': {
        const existing = results[object.metadata.uid];

        if (existing) {
          const currentVersion = parseInt(existing.metadata.resourceVersion, 10);
          const newVersion = parseInt(object.metadata.resourceVersion, 10);
          if (currentVersion < newVersion) {
            Object.assign(existing, object);
          }
        } else {
          results[object.metadata.uid] = object;
        }

        break;
      }
      case 'DELETED':
        delete results[object.metadata.uid];
        break;
      case 'ERROR':
        console.error('Error in update', { type, object });
        break;
      default:
        console.error('Unknown update type', type);
    }

    push();
  }

  function push() {
    const values = Object.values(results);
    cb(values);
  }
}

interface StreamArgs {
  isJson?: boolean;
  additionalProtocols?: string[];
  connectCb?: () => void;
  reconnectOnFailure?: boolean;
}

export function stream(url: string, cb: StreamResultsCb, args: StreamArgs) {
  let connection: ReturnType<typeof connectStream>;
  let isCancelled = false;
  const { isJson = false, additionalProtocols, connectCb, reconnectOnFailure = true } = args;

  connect();

  return { cancel, getSocket };

  function getSocket() {
    return connection.socket;
  }

  function cancel() {
    if (connection) connection.close();
    isCancelled = true;
  }

  function connect() {
    if (connectCb) connectCb();
    connection = connectStream(url, cb, onFail, isJson, additionalProtocols);
  }

  function onFail() {
    if (isCancelled) return;

    if (reconnectOnFailure) {
      console.log('Reconnecting in 3 seconds', { url });
      setTimeout(connect, 3000);
    }
  }
}

function connectStream(
  path: string,
  cb: StreamResultsCb,
  onFail: () => void,
  isJson: boolean,
  additionalProtocols: string[] = []
) {
  let isClosing = false;

  // @todo: This is a temporary way of getting the current cluster. We should improve it later.
  const cluster = getCluster();
  const token = getToken(cluster || '');

  if (token) {
    const encodedToken = btoa(token).replace(/=/g, '');
    additionalProtocols.push(`base64url.bearer.authorization.k8s.io.${encodedToken}`);
  }

  const protocols = ['base64.binary.k8s.io', ...additionalProtocols];

  let fullPath = path;
  if (cluster) {
    fullPath = combinePath(`/${CLUSTERS_PREFIX}/${cluster}`, path);
  }

  const url = combinePath(BASE_WS_URL, fullPath);
  let socket: WebSocket | null = null;
  try {
    socket = new WebSocket(url, protocols);
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', onClose);
    socket.addEventListener('error', onError);
  } catch (error) {
    console.error(error);
  }

  return { close, socket };

  function close() {
    isClosing = true;
    if (!socket) {
      return;
    }
    socket.close();
  }

  function onMessage(body: MessageEvent) {
    if (isClosing) return;

    const item = isJson ? JSON.parse(body.data) : body.data;
    cb(item);
  }

  function onClose(...args: any[]) {
    if (isClosing) return;
    isClosing = true;
    if (!socket) {
      return;
    }

    socket.removeEventListener('message', onMessage);
    socket.removeEventListener('close', onClose);
    socket.removeEventListener('error', onError);

    console.warn('Socket closed unexpectedly', { path, args });
    onFail();
  }

  function onError(err: any) {
    console.error('Error in api stream', { err, path });
  }
}

function combinePath(base: string, path: string) {
  if (base.endsWith('/')) base = base.slice(0, -1); // eslint-disable-line no-param-reassign
  if (path.startsWith('/')) path = path.slice(1); // eslint-disable-line no-param-reassign
  return `${base}/${path}`;
}

export async function apply(body: KubeObjectInterface): Promise<JSON> {
  const resourceName = body.kind;
  let resourceClass: KubeObjectClass | null = null;

  if (resourceName in ResourceClasses) {
    resourceClass = ResourceClasses[resourceName];
  }

  if (!resourceClass) {
    throw new Error(`Cannot handle unknown resource kind: ${body.kind}`);
  }

  try {
    return await resourceClass!.apiEndpoint.post(body);
  } catch (err) {
    // Check to see if failed because the record already exists.
    // If the failure isn't a 409 (i.e. Confilct), just rethrow.
    if (err.status !== 409) throw err;

    // We had a confilct. Try a PUT
    return resourceClass!.apiEndpoint.put(body);
  }
}

export interface ApiError extends Error {
  status: number;
}

export async function metrics(
  url: string,
  onMetrics: (arg: KubeMetrics[]) => void,
  onError?: (err: ApiError) => void
) {
  const handel = setInterval(getMetrics, 10000);

  async function getMetrics() {
    try {
      const metric = await request(url);
      onMetrics(metric.items || metric);
    } catch (err) {
      console.debug('No metrics', { err, url });

      if (onError) {
        onError(err);
      }
    }
  }

  function cancel() {
    clearInterval(handel);
  }

  getMetrics();

  return cancel;
}

export async function testAuth() {
  const spec = { namespace: 'default' };
  return post('/apis/authorization.k8s.io/v1/selfsubjectrulesreviews', { spec }, false, {
    timeout: 5 * 1000,
  });
}
