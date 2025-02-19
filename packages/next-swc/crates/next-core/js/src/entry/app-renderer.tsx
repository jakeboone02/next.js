// IPC need to be the first import to allow it to catch errors happening during
// the other imports
import startOperationStreamHandler from '../internal/operation-stream'

import '../polyfill/app-polyfills.ts'
// TODO: when actions are supported, this should be removed/changed
process.env.__NEXT_PRIVATE_PREBUNDLED_REACT = 'next'
import 'next/dist/server/require-hook'

import type { IncomingMessage } from 'node:http'

import type { RenderData } from 'types/turbopack'
import type { RenderOpts } from 'next/dist/server/app-render/types'

import { RSC_VARY_HEADER } from 'next/dist/client/components/app-router-headers'
import { headersFromEntries, initProxiedHeaders } from '../internal/headers'
import { parse, ParsedUrlQuery } from 'node:querystring'
import { PassThrough } from 'node:stream'
;('TURBOPACK { chunking-type: isolatedParallel }')
import entry from 'APP_ENTRY'
import BOOTSTRAP from 'APP_BOOTSTRAP'
import { createServerResponse } from '../internal/http'
import { createManifests, installRequireAndChunkLoad } from './app/manifest'
import { join } from 'node:path'
import { nodeFs } from 'next/dist/server/lib/node-fs-methods'
import { IncrementalCache } from 'next/dist/server/lib/incremental-cache'

const {
  renderToHTMLOrFlight,
} = require('next/dist/compiled/next-server/app-page.runtime.dev')

installRequireAndChunkLoad()

const MIME_TEXT_HTML_UTF8 = 'text/html; charset=utf-8'

startOperationStreamHandler(async (renderData: RenderData, respond) => {
  const result = await runOperation(renderData)

  if (result == null) {
    throw new Error('no html returned')
  }

  const channel = respond({
    status: result.statusCode,
    headers: result.headers,
  })

  for await (const chunk of result.body) {
    channel.chunk(chunk as Buffer)
  }

  channel.end()
})

async function runOperation(renderData: RenderData) {
  const { clientReferenceManifest } = createManifests()

  const req: IncomingMessage = {
    url: renderData.originalUrl,
    method: renderData.method,
    headers: initProxiedHeaders(
      headersFromEntries(renderData.rawHeaders),
      renderData.data?.serverInfo
    ),
  } as any

  const url = new URL(renderData.originalUrl, 'next://')

  const res = createServerResponse(req, renderData.path)

  const query = parse(renderData.rawQuery)
  const renderOpt: Omit<
    RenderOpts,
    'App' | 'Document' | 'Component' | 'page'
  > & {
    params: ParsedUrlQuery
  } = {
    // TODO: give an actual buildId when next build is supported
    buildId: 'development',
    basePath: '',
    params: renderData.params,
    supportsDynamicHTML: true,
    dev: true,
    buildManifest: {
      polyfillFiles: [],
      rootMainFiles: BOOTSTRAP.filter((path) => path.endsWith('.js')),
      devFiles: [],
      ampDevFiles: [],
      lowPriorityFiles: [],
      pages: {
        '/_app': [],
      },
      ampFirstPages: [],
    },
    ComponentMod: {
      ...entry,
      __next_app__: {
        require: __next_require__,
        loadChunk: __next_chunk_load__,
      },
      pages: ['page.js'],
    },
    incrementalCache: new IncrementalCache({
      fs: nodeFs,
      dev: true,
      requestHeaders: { ...req.headers },
      requestProtocol: url.protocol.replace(/:$/, '') as 'http' | 'https',
      appDir: true,
      allowedRevalidateHeaderKeys: renderData.data?.allowedRevalidateHeaderKeys,
      minimalMode: false,
      serverDistDir: join(process.cwd(), '.next/server'),
      fetchCache: true,
      fetchCacheKeyPrefix: renderData.data?.fetchCacheKeyPrefix,
      maxMemoryCacheSize: renderData.data?.isrMemoryCacheSize,
      flushToDisk: false,
      getPrerenderManifest: () => ({
        version: 4,
        routes: {},
        dynamicRoutes: {},
        preview: {
          previewModeEncryptionKey: '',
          previewModeId: '',
          previewModeSigningKey: '',
        },
        notFoundRoutes: [],
      }),
      CurCacheHandler: undefined,
    }),
    clientReferenceManifest,
    runtime: 'nodejs',
    serverComponents: true,
    assetPrefix: '',
    pageConfig: {},
    reactLoadableManifest: {},
    nextConfigOutput: renderData.data?.nextConfigOutput,
  }
  const result = await renderToHTMLOrFlight(
    req,
    res,
    renderData.path,
    query,
    renderOpt as any as RenderOpts
  )

  if (!result || result.isNull) throw new Error('rendering was not successful')

  const body = new PassThrough()
  if (result.isDynamic) {
    result.pipe(body)
  } else {
    body.write(result.toUnchunkedString())
  }
  return {
    statusCode: res.statusCode,
    headers: [
      ['Content-Type', result.contentType ?? MIME_TEXT_HTML_UTF8],
      ['Vary', RSC_VARY_HEADER],
    ] as [string, string][],
    body,
  }
}
