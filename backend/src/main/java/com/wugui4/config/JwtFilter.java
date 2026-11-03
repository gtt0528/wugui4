package com.wugui4.config;

import com.wugui4.service.JwtService;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * 简易鉴权过滤器：
 *   /api/auth/**          —— 放行（登录入口）
 *   带合法 JWT             —— 把 userId 塞进 request attribute
 *   带内部令牌（gameserver） —— 标记 internal=true，用于服务间上报
 */
@Component
public class JwtFilter extends OncePerRequestFilter {

    private final JwtService jwt;
    private final String internalToken;

    public JwtFilter(JwtService jwt, @Value("${wugui4.internal-token}") String internalToken) {
        this.jwt = jwt;
        this.internalToken = internalToken;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String p = request.getRequestURI();
        // 排行榜公开可看（仅放行 GET，/api/auth/** 是登录入口）
        if ("GET".equals(request.getMethod()) && p.startsWith("/api/rank")) return true;
        return p.startsWith("/api/auth/");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse resp, FilterChain chain)
            throws ServletException, IOException {

        String header = req.getHeader("Authorization");
        if (header != null && header.startsWith("Bearer ")) {
            Long userId = jwt.verify(header.substring(7));
            if (userId != null) {
                req.setAttribute("userId", userId);
                chain.doFilter(req, resp);
                return;
            }
            resp.sendError(401, "token 无效或已过期");
            return;
        }

        // 服务间调用（gameserver 上报战绩）
        String internal = req.getHeader("X-Internal-Token");
        if (internalToken.equals(internal)) {
            req.setAttribute("internal", true);
            chain.doFilter(req, resp);
            return;
        }

        resp.sendError(401, "未登录");
    }
}
