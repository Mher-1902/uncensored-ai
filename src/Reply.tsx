import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
export default function Reply({text}:{text:string}){
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{a:({children,...p})=><a {...p} target="_blank" rel="noopener noreferrer">{children}</a>,img:({alt})=><em>[{alt||'External image omitted'}]</em>}}>{text}</ReactMarkdown>;
}
