// Turns the conversation API's message tree into a readable Markdown transcript.
// Message selection (the visible branch, which node kinds to skip, merging continuations) and
// citation handling follow pionxzh/chatgpt-exporter (MIT); see THIRD_PARTY_NOTICES.md.
const Transcript = (() => {
  // Private-use markers ChatGPT wraps around inline citations and entities.
  const MARKER = /\uE200[^\uE200\uE201]*\uE201/gu;
  function isConversation(data) {
    return !!data && typeof data === 'object' && !Array.isArray(data) &&
      !!data.mapping && typeof data.mapping === 'object' && !Array.isArray(data.mapping);
  }
  function hasImage(content) {
    return Array.isArray(content.parts) && content.parts.some(part => part?.content_type === 'image_asset_pointer');
  }
  function skipped(message) {
    if (!message?.content || !message.author) return true;
    const role = message.author.role;
    const type = message.content.content_type;
    const meta = message.metadata || {};
    if (role === 'system') return true;
    // The model addressing a tool (web.run, python, internal_tool…) rather than the user.
    if (message.recipient && message.recipient !== 'all') return true;
    // Hidden reasoning, saved memories and custom instructions are not part of the visible chat.
    if (['thoughts', 'reasoning_recap', 'model_editable_context', 'user_editable_context'].includes(type)) return true;
    if (meta.is_visually_hidden_from_conversation || meta.is_thinking_preamble_message) return true;
    if (role === 'assistant' && type === 'text' && !(message.content.parts || []).join('').trim()) return true;
    // Tool output appears only when ChatGPT shows it inline: generated images and charts.
    if (role === 'tool') {
      if (type === 'execution_output') return !meta.aggregate_result?.messages?.some(m => m?.message_type === 'image');
      return !hasImage(message.content);
    }
    return false;
  }
  function branch(data) {
    const mapping = data.mapping;
    const start = data.current_node || Object.values(mapping).find(node => node && !node.children?.length)?.id;
    const messages = [];
    const seen = new Set();
    for (let id = start; id && mapping[id] && !seen.has(id); id = mapping[id].parent) {
      seen.add(id);
      if (!skipped(mapping[id].message)) messages.unshift(mapping[id].message);
    }
    return messages;
  }
  function speaker(role) { return role === 'user' ? 'You' : role === 'assistant' || role === 'tool' ? 'ChatGPT' : role; }
  function escapeLabel(text) { return String(text).replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]').replace(/\s+/g, ' '); }
  function target(url) { return String(url).replace(/[<>\s]/g, '').replace(/%(?![0-9A-Fa-f]{2})/g, '%25'); }
  // Relative link to a downloaded attachment, so the transcript works when saved next to the files.
  function localTarget(name) { return name.replace(/%/g, '%25').replace(/#/g, '%23').replace(/\?/g, '%3F').replace(/[<>]/g, ''); }
  function fileId(pointer) { return String(pointer || '').match(/file[-_][A-Za-z0-9_-]+/)?.[0] || null; }
  function image(pointer, names) {
    const name = names.get(fileId(pointer));
    return name ? `![${escapeLabel(name)}](<${localTarget(name)}>)` : '[image]';
  }
  function fence(text, language = '') {
    const longest = Math.max(0, ...(String(text).match(/`+/g) || []).map(run => run.length));
    const ticks = '`'.repeat(Math.max(3, longest + 1));
    return `${ticks}${/^[\w+#.-]{1,30}$/.test(language) && language !== 'unknown' ? language : ''}\n${text}\n${ticks}`;
  }
  function sourceLabel(source) { return String(source.attribution || source.title || source.url || 'Source').trim(); }
  function formatSource(source) {
    const url = typeof source.url === 'string' ? source.url.trim() : '';
    return url ? `[${escapeLabel(sourceLabel(source))}](<${target(url)}>)` : escapeLabel(sourceLabel(source));
  }
  function dedupe(sources) {
    const seen = new Set();
    return sources.filter(source => {
      const key = (typeof source?.url === 'string' && source.url.trim()) || (source && sourceLabel(source));
      if (!key || seen.has(key)) return false;
      seen.add(key); return true;
    });
  }
  function inlineSources(ref) {
    const sources = [];
    for (const item of ref.items || []) sources.push(item, ...(item?.supporting_websites || []));
    sources.push(...(ref.fallback_items || []));
    if (!sources.length && ref.type === 'file' && ref.name) sources.push({ title: ref.name });
    if (!sources.length && (ref.url || ref.title || ref.attribution)) sources.push(ref);
    if (!sources.length) sources.push(...(ref.safe_urls || []).filter(Boolean).map(url => ({ title: url, url })));
    return dedupe(sources.filter(Boolean));
  }
  function citations(text, meta) {
    let output = text;
    const refs = (Array.isArray(meta?.content_references) ? meta.content_references : [])
      .filter(ref => ref && typeof ref.matched_text === 'string' && ref.matched_text && ref.type !== 'sources_footnote')
      .sort((a, b) => b.matched_text.length - a.matched_text.length);
    for (const ref of refs) {
      // ChatGPT draws these as widgets, but the text already holds their Markdown.
      if (ref.type === 'client_defined_widget' && ref.data?.widget_type === 'code_block') continue;
      const sources = inlineSources(ref);
      const replacement = sources.length ? `(${sources.map(formatSource).join(', ')})`
        : String(ref.alt || '').replace(/\[([^\]]*)\]\(\)/g, '$1');
      output = output.split(ref.matched_text).join(replacement);
    }
    output = output.replace(MARKER, '').replace(/[\uE203\uE204]/g, '');
    // Older footnote style: 【11†(Source title)】.
    const notes = [];
    output = output.replace(/【(\d+)†\((.+?)\)】/g, (match, index) => {
      const citation = meta?.citations?.find(cite => cite?.metadata?.extra?.cited_message_idx === Number(index));
      if (!citation) return match;
      notes.push(`[^${index}]: ${citation.metadata?.title || 'No title'}`);
      return `[^${index}]`;
    });
    const footnote = dedupe((Array.isArray(meta?.content_references) ? meta.content_references : [])
      .filter(ref => ref?.type === 'sources_footnote')
      .flatMap(ref => ref.sources?.length ? ref.sources : ref.items?.length ? ref.items : ref.fallback_items || []).filter(Boolean));
    if (notes.length) output += `\n\n${notes.join('\n')}`;
    if (footnote.length) output += `\n\n**Sources:**\n\n${footnote.map(source => `- ${formatSource(source)}`).join('\n')}`;
    return output;
  }
  function body(message, names) {
    const content = message.content;
    const meta = message.metadata || {};
    const prose = text => message.author.role === 'assistant' ? citations(text, meta) : text;
    switch (content.content_type) {
      case 'text': {
        // Interactive replies keep widget markup in parts; ChatGPT stores a Markdown version alongside.
        const fallback = meta.model_dil_v2?.fallbackMarkdown;
        if (typeof fallback === 'string' && fallback.trim()) return prose(fallback.replace(/<escape>([\s\S]*?)<\/escape>/g, '$1'));
        return prose((content.parts || []).filter(part => typeof part === 'string').join('\n'));
      }
      case 'multimodal_text':
        return (content.parts || []).map(part => {
          if (typeof part === 'string') return prose(part);
          if (part?.content_type === 'image_asset_pointer') return image(part.asset_pointer, names);
          if (part?.content_type === 'audio_transcription') return `[audio] ${part.text || ''}`;
          if (/audio|video/.test(part?.content_type || '')) return null;
          return '[unsupported content]';
        }).filter(part => part !== null && part !== '').join('\n\n');
      case 'code':
        return fence(content.text || '', content.language);
      case 'execution_output': {
        const images = (meta.aggregate_result?.messages || []).filter(m => m?.message_type === 'image');
        if (images.length) return images.map(m => image(m.image_url, names)).join('\n\n');
        return `Result:\n\n${fence(content.text || '')}`;
      }
      case 'tether_quote': {
        const quote = String(content.text || content.title || '').split('\n').map(line => `> ${line}`).join('\n');
        return content.title && content.text ? `${quote}\n>\n> — ${content.title}` : quote;
      }
      case 'tether_browsing_display': {
        const list = meta._cite_metadata?.metadata_list;
        return Array.isArray(list) ? list.map(item => `> ${formatSource(item)}`).join('\n') : '';
      }
      default:
        return `[Unsupported content: ${String(content.content_type).replace(/[^\w.-]/g, '')}]`;
    }
  }
  function attachments(message, names) {
    const list = Array.isArray(message.metadata?.attachments) ? message.metadata.attachments : [];
    // Uploaded images already appear as image parts of the message.
    return list.filter(item => item?.name && !String(item.mime_type || '').startsWith('image/')).map(item => {
      const saved = names.get(item.id);
      return `- 📎 ${saved ? `[${escapeLabel(item.name)}](<${localTarget(saved)}>)` : escapeLabel(item.name)}`;
    }).join('\n');
  }
  function when(seconds) {
    return Number.isFinite(seconds) && seconds > 0 ? `${new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';
  }
  function render(data, { conversationId, names = new Map(), exportedAt = Date.now() } = {}) {
    const turns = [];
    const messages = branch(data);
    for (const message of messages) {
      const text = [body(message, names), attachments(message, names)].filter(Boolean).join('\n\n').trim();
      if (!text) continue;
      const who = speaker(message.author.role);
      const previous = turns[turns.length - 1];
      // Continuations and inline tool images belong to the same reply.
      if (previous?.who === who && who === 'ChatGPT') previous.text += `\n\n${text}`;
      else turns.push({ who, at: when(message.create_time), text });
    }
    const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : 'ChatGPT conversation';
    const model = data.default_model_slug || messages.findLast(m => m.metadata?.model_slug)?.metadata.model_slug;
    const details = [
      conversationId ? `- Conversation: <${Config.ORIGIN}/c/${conversationId}>` : '',
      when(data.create_time) ? `- Created: ${when(data.create_time)}` : '',
      when(data.update_time) ? `- Updated: ${when(data.update_time)}` : '',
      typeof model === 'string' && model ? `- Model: ${model}` : '',
      `- Exported: ${when(exportedAt / 1000)} with ChatGPT Attachment Downloader ${Config.VERSION}`,
    ].filter(Boolean);
    const sections = turns.map(turn => `### ${turn.who}${turn.at ? ` · ${turn.at}` : ''}\n\n${turn.text}`);
    return { title, messages: turns.length, markdown: `# ${title}\n\n${details.join('\n')}\n\n---\n\n${sections.join('\n\n---\n\n')}\n` };
  }
  return Object.freeze({ isConversation, branch, render });
})();
