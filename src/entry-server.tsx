import {createElement} from 'react';
import {renderToString,renderToStaticMarkup} from 'react-dom/server';
import {App} from './App';
import {PrivacyPage} from './Privacy';
import {CookiesPage} from './Cookies';
export function render(){return renderToString(createElement(App))}
export function renderPrivacy(){return '<!doctype html>'+renderToStaticMarkup(createElement(PrivacyPage))}
export function renderCookies(){return '<!doctype html>'+renderToStaticMarkup(createElement(CookiesPage))}
