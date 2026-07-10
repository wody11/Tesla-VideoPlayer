import Emitter from "../utils/emitter";
import {EVENTS, EVENTS_ERROR, FETCH_ERROR, JESSIBUCA_EVENTS} from "../constant";
import {calculationRate, isFalse, isFetchSuccess, now} from "../utils";

export default class FetchLoader extends Emitter {
    constructor(player) {
        super();
        this.player = player;
        this.playing = false;

        this.abortController = new AbortController();
        //
        this.streamRate = calculationRate(rate => {
            player.emit(EVENTS.kBps, (rate / 1000).toFixed(2));
        });
        player.debug.log('FetchStream', 'init');
    }

    async destroy() {
        this.abort()
        this.off();
        this.streamRate = null;
        this.player.debug.log('FetchStream', 'destroy');
    }

    /**
     *
     * @param url
     * @param options
     */
    fetchStream(url, options = {}) {
        const {demux} = this.player;
        this.player.debug.log('FetchStream', 'fetchStream', url, JSON.stringify(options));
        this.player._times.streamStart = now();
        if (!this.abortController) {
            this.abortController = new AbortController();
        }
        const fetchOptions = Object.assign({
            signal: this.abortController.signal,
        }, {
            headers: options.headers || {}
        });
        fetch(url, fetchOptions).then((res) => {
            if(isFalse(isFetchSuccess(res))){
                this.player.debug.log('FetchStream', `fetch response status is ${res.status} and ok is ${res.ok} and emit error and next abort()`);
                this.abort();
                this.emit(EVENTS_ERROR.fetchError, `fetch response status is ${res.status} and ok is ${res.ok}`);
                this.player.emit(EVENTS.error, EVENTS_ERROR.fetchError);
                return;
            }

            const reader = res.body.getReader();
            this.emit(EVENTS.streamSuccess);
            const fetchNext = () => {
                reader.read().then(({done, value}) => {
                        if (done) {
                            demux.close();
                        } else {
                            this.streamRate && this.streamRate(value.byteLength * 8);
                            demux.dispatch(value);
                            fetchNext();
                        }
                    }
                ).catch((e) => {
                    demux.close();
                    const errorString = e.toString();
                    // aborted a request 。
                    if (errorString.indexOf(FETCH_ERROR.abortError1) !== -1) {
                        return
                    }

                    if (errorString.indexOf(FETCH_ERROR.abortError2) !== -1) {
                        return;
                    }

                    if (e.name === FETCH_ERROR.abort) {
                        return;
                    }


                    this.abort();

                    this.emit(EVENTS_ERROR.fetchError, e);
                    this.player.emit(EVENTS.error, EVENTS_ERROR.fetchError);
                })
            }
            fetchNext();
        }).catch((e) => {
            if (e.name === 'AbortError') {
                return;
            }
            demux.close();
            this.abort();
            this.emit(EVENTS_ERROR.fetchError, e)
            this.player.emit(EVENTS.error, EVENTS_ERROR.fetchError);
        })
    }

    abort() {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null
        }
    }
}
