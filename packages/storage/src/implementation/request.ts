/**
 * @license
 * Copyright 2017 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @fileoverview Defines methods used to actually send HTTP requests from
 * abstract representations.
 */

import firebase from '@firebase/app';
import * as array from './array';
import * as backoff from './backoff';
import * as errorsExports from './error';
import { FirebaseStorageError } from './error';
import * as object from './object';
import * as promiseimpl from './promise_external';
import { RequestInfo } from './requestinfo';
import * as type from './type';
import * as UrlUtils from './url';
import * as XhrIoExports from './xhrio';
import { Headers, XhrIo } from './xhrio';
import { XhrIoPool } from './xhriopool';

/**
 * @template T
 */
export interface Request<T> {
  getPromise(): Promise<T>;

  /**
   * Cancels the request. IMPORTANT: the promise may still be resolved with an
   * appropriate value (if the request is finished before you call this method,
   * but the promise has not yet been resolved), so don't just assume it will be
   * rejected if you call this function.
   * @param appDelete True if the cancelation came from the app being deleted.
   */
  cancel(appDelete?: boolean): void;
}

/**
 * @struct
 * @template T
 */
class NetworkRequest<T> implements Request<T> {
  private url_: string;
  private method_: string;
  private headers_: Headers;
  private body_: string | Blob | Uint8Array | null;
  private successCodes_: number[];
  private additionalRetryCodes_: number[];
  private pendingXhr_: XhrIo | null = null;
  private backoffId_: backoff.id | null = null;
  private resolve_: Function | null = null;
  private reject_: Function | null = null;
  private canceled_: boolean = false;
  private appDelete_: boolean = false;
  private callback_: (p1: XhrIo, p2: string) => T;
  private errorCallback_:
    | ((p1: XhrIo, p2: FirebaseStorageError) => FirebaseStorageError)
    | null;
  private progressCallback_: ((p1: number, p2: number) => void) | null;
  private timeout_: number;
  private pool_: XhrIoPool;
  promise_: Promise<T>;

  constructor(
    url: string,
    method: string,
    headers: Headers,
    body: string | Blob | Uint8Array | null,
    successCodes: number[],
    additionalRetryCodes: number[],
    callback: (p1: XhrIo, p2: string) => T,
    errorCallback:
      | ((p1: XhrIo, p2: FirebaseStorageError) => FirebaseStorageError)
      | null,
    timeout: number,
    progressCallback: ((p1: number, p2: number) => void) | null,
    pool: XhrIoPool
  ) {
    this.url_ = url;
    this.method_ = method;
    this.headers_ = headers;
    this.body_ = body;
    this.successCodes_ = successCodes.slice();
    this.additionalRetryCodes_ = additionalRetryCodes.slice();
    this.callback_ = callback;
    this.errorCallback_ = errorCallback;
    this.progressCallback_ = progressCallback;
    this.timeout_ = timeout;
    this.pool_ = pool;
    const self = this;
    this.promise_ = promiseimpl.make((resolve, reject) => {
      self.resolve_ = resolve;
      self.reject_ = reject;
      self.start_();
    });
  }

  /**
   * Actually starts the retry loop.
   */
  private start_(): void {
    const self = this;

    function doTheRequest(
      backoffCallback: (p1: boolean, ...p2: unknown[]) => void,
      canceled: boolean
    ): void {
      if (canceled) {
        backoffCallback(false, new RequestEndStatus(false, null, true));
        return;
      }
      const xhr = self.pool_.createXhrIo();
      self.pendingXhr_ = xhr;

      function progressListener(progressEvent: ProgressEvent): void {
        const loaded = progressEvent.loaded;
        const total = progressEvent.lengthComputable ? progressEvent.total : -1;
        if (self.progressCallback_ !== null) {
          self.progressCallback_(loaded, total);
        }
      }
      if (self.progressCallback_ !== null) {
        xhr.addUploadProgressListener(progressListener);
      }

      // tslint:disable-next-line:no-floating-promises
      xhr
        .send(self.url_, self.method_, self.body_, self.headers_)
        .then((xhr: XhrIo) => {
          if (self.progressCallback_ !== null) {
            xhr.removeUploadProgressListener(progressListener);
          }
          self.pendingXhr_ = null;
          xhr = xhr as XhrIo;
          const hitServer =
            xhr.getErrorCode() === XhrIoExports.ErrorCode.NO_ERROR;
          const status = xhr.getStatus();
          if (!hitServer || self.isRetryStatusCode_(status)) {
            const wasCanceled =
              xhr.getErrorCode() === XhrIoExports.ErrorCode.ABORT;
            backoffCallback(
              false,
              new RequestEndStatus(false, null, wasCanceled)
            );
            return;
          }
          const successCode = array.contains(self.successCodes_, status);
          backoffCallback(true, new RequestEndStatus(successCode, xhr));
        });
    }

    /**
     * @param requestWentThrough True if the request eventually went
     *     through, false if it hit the retry limit or was canceled.
     */
    function backoffDone(
      _requestWentThrough: boolean,
      status: RequestEndStatus
    ): void {
      const resolve = self.resolve_ as Function;
      const reject = self.reject_ as Function;
      const xhr = status.xhr as XhrIo;
      if (status.wasSuccessCode) {
        try {
          const result = self.callback_(xhr, xhr.getResponseText());
          if (type.isJustDef(result)) {
            resolve(result);
          } else {
            resolve();
          }
        } catch (e) {
          reject(e);
        }
      } else {
        if (xhr !== null) {
          const err = errorsExports.unknown();
          err.setServerResponseProp(xhr.getResponseText());
          if (self.errorCallback_) {
            reject(self.errorCallback_(xhr, err));
          } else {
            reject(err);
          }
        } else {
          if (status.canceled) {
            const err = self.appDelete_
              ? errorsExports.appDeleted()
              : errorsExports.canceled();
            reject(err);
          } else {
            const err = errorsExports.retryLimitExceeded();
            reject(err);
          }
        }
      }
    }
    if (this.canceled_) {
      backoffDone(false, new RequestEndStatus(false, null, true));
    } else {
      this.backoffId_ = backoff.start(doTheRequest, backoffDone, this.timeout_);
    }
  }

  /** @inheritDoc */
  getPromise(): Promise<T> {
    return this.promise_;
  }

  /** @inheritDoc */
  cancel(appDelete?: boolean): void {
    this.canceled_ = true;
    this.appDelete_ = appDelete || false;
    if (this.backoffId_ !== null) {
      backoff.stop(this.backoffId_);
    }
    if (this.pendingXhr_ !== null) {
      this.pendingXhr_.abort();
    }
  }

  private isRetryStatusCode_(status: number): boolean {
    // The codes for which to retry came from this page:
    // https://cloud.google.com/storage/docs/exponential-backoff
    const isFiveHundredCode = status >= 500 && status < 600;
    const extraRetryCodes = [
      // Request Timeout: web server didn't receive full request in time.
      408,
      // Too Many Requests: you're getting rate-limited, basically.
      429
    ];
    const isExtraRetryCode = array.contains(extraRetryCodes, status);
    const isRequestSpecificRetryCode = array.contains(
      this.additionalRetryCodes_,
      status
    );
    return isFiveHundredCode || isExtraRetryCode || isRequestSpecificRetryCode;
  }
}

/**
 * A collection of information about the result of a network request.
 * @param opt_canceled Defaults to false.
 * @struct
 */
export class RequestEndStatus {
  /**
   * True if the request was canceled.
   */
  canceled: boolean;

  constructor(
    public wasSuccessCode: boolean,
    public xhr: XhrIo | null,
    canceled?: boolean
  ) {
    this.canceled = !!canceled;
  }
}

export function addAuthHeader_(headers: Headers, authToken: string | null): void {
  if (authToken !== null && authToken.length > 0) {
    headers['Authorization'] = 'Firebase ' + authToken;
  }
}

export function addVersionHeader_(headers: Headers): void {
  const version =
    typeof firebase !== 'undefined' ? firebase.SDK_VERSION : 'AppManager';
  headers['X-Firebase-Storage-Version'] = 'webjs/' + version;
}

/**
 * @template T
 */
export function makeRequest<T>(
  requestInfo: RequestInfo<T>,
  authToken: string | null,
  pool: XhrIoPool
): Request<T> {
  const queryPart = UrlUtils.makeQueryString(requestInfo.urlParams);
  const url = requestInfo.url + queryPart;
  const headers = object.clone<Headers>(requestInfo.headers);
  addAuthHeader_(headers, authToken);
  addVersionHeader_(headers);
  return new NetworkRequest<T>(
    url,
    requestInfo.method,
    headers,
    requestInfo.body,
    requestInfo.successCodes,
    requestInfo.additionalRetryCodes,
    requestInfo.handler,
    requestInfo.errorHandler,
    requestInfo.timeout,
    requestInfo.progressCallback,
    pool
  );
}
